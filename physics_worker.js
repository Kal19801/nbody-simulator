/* physics_worker.js — v34 多线程 worker（双角色）
 *
 * w === 0：physics 编排 worker —— 接收帧派发，跑积分器（JS 编排 + WASM 内核），
 *          对 N ≥ 256 的力求值经控制块行分割派发至 w≥1（accumMT）。
 * w >= 1 ：计算 worker —— 初始化后进入 workerLoop() 阻塞等待行任务。
 *
 * 状态零拷贝：全部状态位于共享 WebAssembly.Memory，各实例以 setBlock 同步块基址。
 */
'use strict';
/* 双环境加载：浏览器 worker 用 importScripts；Node worker_threads 测试台架用间接 eval
 * （保持 physics_core.js 顶层 let/const 词法绑定落在 worker 全局作用域） */
if (typeof importScripts === 'function') importScripts('physics_core.js');
else {
  /* Node worker_threads 测试环境垫片：self/postMessage/onmessage 语义对齐浏览器 */
  globalThis.self = globalThis;
  const __pp = require('node:worker_threads').parentPort;
  globalThis.postMessage = (m) => __pp.postMessage(m);
  globalThis.__onmessage = null;
  Object.defineProperty(globalThis, 'onmessage', {
    set(fn) { globalThis.__onmessage = fn; __pp.on('message', (ev) => fn({ data: ev })); },
    get() { return globalThis.__onmessage; }
  });
  /* 顶层 'use strict' 指令会使间接 eval 的词法绑定局限在 eval 域内（Node 路径仅测试用），
   * 去除指令后 let/const/function 落入 worker 全局词法环境 —— 与 classic script 语义一致 */
  (0, eval)(require('node:fs').readFileSync(require('node:path').join(__dirname, 'physics_core.js'), 'utf8')
    .replace(/^\s*'use strict';/, ''));
}

const SEC_ORDER = [
  'px', 'py', 'pz', 'vx', 'vy', 'vz', 'ax', 'ay', 'az', 'massA',
  'cpx', 'cpy', 'cpz', 'cvx', 'cvy', 'cvz',
  'spinRate', 'spinAcc', 'spinTx', 'spinTy', 'spinTz', 'spinPhase', 'cspinPhase',
  'spinAxX', 'spinAxY', 'spinAxZ',
  'bodyRadA', 'bodyK2A', 'bodyLagA', 'bodyIA', 'bodyTideA0', 'bodyTideA03', 'bodyK2Auto', 'bodyLagAuto',
  'axRR', 'ayRR', 'azRR', 'axTL', 'ayTL', 'azTL',
  'mpPx', 'mpPy', 'mpPz', 'mpVx', 'mpVy', 'mpVz',
  'mpAx', 'mpAy', 'mpAz', 'mpRX', 'mpRY', 'mpRZ', 'mpTX', 'mpTY', 'mpTZ',
  'mpPnX', 'mpPnY', 'mpPnZ', 'mpVnX', 'mpVnY', 'mpVnZ', 'mpSpin',
  'ySnapPx', 'ySnapPy', 'ySnapPz', 'ySnapVx', 'ySnapVy', 'ySnapVz',
  'ySnapCpx', 'ySnapCpy', 'ySnapCpz', 'ySnapCvx', 'ySnapCvy', 'ySnapCvz',
  'ySpinRate', 'ySpinPhase', 'yCspinPhase', 'ySpinAxX', 'ySpinAxY', 'ySpinAxZ'
];
const N_SEC = 80, FIX_BYTES = 119 * 8, F_STATS = 0, F_MPI = 5, F_SCAN = 23;
const LED_NAMES = ['sinkGWE', 'sinkTideE', 'sinkGWLx', 'sinkGWLv', 'sinkGWLz', 'fieldPx', 'fieldPv', 'fieldPz'];
const MT_N_MIN = 256;   // 行分割并行阈值（小 N 派发开销大于收益）

const core = globalThis.__NBODY_CORE__;
const R = core.refs();
const Fn = core.fns();

let W = { inst: null, exp: null, cap: 0, base: 0, statsView: null, mpiView: null, scanView: null, myW: -1, useMT: false, bhTheta: null, lastN: -1 };

function mask() {
  return (R.gr1pnOn ? 1 : 0) | (R.gr15spinOn ? 2 : 0) | (R.gr2pnOn ? 4 : 0) |
    (R.gr25On ? 8 : 0) | (R.gr35On ? 16 : 0) | (R.tideOn ? 32 : 0) |
    (R.j2On ? 64 : 0) | (R.pwOn ? 128 : 0);   /* v35：J2/PW 独立位 */
}
function syncStatsFromView() {
  R.minR2 = W.statsView[0]; R.maxAccMag = W.statsView[1]; R.minPairM = W.statsView[2];
  R.minPairV2 = W.statsView[3]; R.tideHeatW = W.statsView[4];
}
function buildViews(cap) {
  const base = W.base;
  const arrs = {};
  SEC_ORDER.forEach((name, s) => {
    arrs[name] = new Float64Array(W.memory.buffer, base + FIX_BYTES + s * cap * 8, cap);
  });
  R.setArrs(arrs);
  const led = {};
  LED_NAMES.forEach((name, k) => { led[name] = new Float64Array(W.memory.buffer, base + (7 + k * 2) * 8, 2); });
  R.setLedgers(led);
  W.statsView = new Float64Array(W.memory.buffer, base + F_STATS * 8, 5);
  W.mpiView = new Float64Array(W.memory.buffer, base + F_MPI * 8, 2);
  W.scanView = new Float64Array(W.memory.buffer, base + F_SCAN * 8, 8);
  W.iasRetView = new Float64Array(W.memory.buffer, base + 31 * 8, 1);   /* v34b: iasTry dtNext 回传位 */
  W.cap = cap;
  R.CAP = cap;
  R.bufVer = R.bufVer + 1;
}

/* worker 侧引擎桩：钩子由此接入 */
globalThis.__ENGINE__ = {
  active: true,
  growCap(n) {
    const newCap = Math.max(n, W.cap ? W.cap * 2 : 64);
    W.exp.blkResize(newCap);
    W.base = W.exp.getBlkBase();
    buildViews(newCap);
  },
  accumDispatch() {
    const n = R.N, m = mask();
    /* v34b：BH 选择随帧传入（与主线程 accumDispatch 同规则：N≥512 才用树） */
    if (W.bhTheta && n >= 512) W.exp.accumBH(n, m, W.bhTheta);
    else if (W.useMT && n >= MT_N_MIN) W.exp.accumMT(n, m);
    else W.exp.accumST(n, m);
    syncStatsFromView();
  },
  stepYoshida4(h, refresh) {
    const a = R.YOSHIDA_W1 * h, b = R.YOSHIDA_W0 * h;
    const fast = !R.gr1pnOn && !R.gr25On && !R.gr2pnOn && !R.tideOn;
    if (fast) W.exp.yoshFast(a, b, R.N, mask());
    else W.exp.yoshPN(a, b, R.N, mask(), refresh ? 1 : 0);
    syncStatsFromView();
    R.mpIterLast = W.mpiView[0]; R.mpConvLast = W.mpiView[1] !== 0;
    return fast ? true : R.mpConvLast;
  },
  scanStats(useMid, out) {
    W.exp.scanStats(R.N, mask(), useMid ? 1 : 0, useMid ? 1 : 0);
    const off = useMid ? 4 : 0;
    out.minR2 = W.scanView[off + 0]; out.minPairM = W.scanView[off + 1];
    out.minPairV2 = W.scanView[off + 2]; out.spinCoef = W.scanView[off + 3];
    return out;
  },
  /* v34b: IAS15 整步核派发（iasTry 逐位移植；状态机与主线程引擎同构） */
  iasStepTry(h, refresh, fixed) {
    if (!R.iasReady) { W.exp.iasReset(); R.iasReady = true; }
    const acc = W.exp.iasTry(R.N, h, mask(), fixed ? 1 : 0, refresh !== false ? 1 : 0,
      R.iasLastDt, R.iasEpsilon, R.IAS_ADAPTIVE_MODE);
    const dtNext = W.iasRetView ? W.iasRetView[0] : h;
    if (acc) R.iasLastDt = h; else R.iasRejectCount++;
    syncStatsFromView();
    return { acc: acc === 1, dtNext };
  }
};

/* integrateFrame：physicsAdvance 的纯积分部分（UI/并合留在主线程）
 * v35：引力波采样随帧内子步在 worker 侧执行（computeGWStrainCore 仅依赖
 * 共享状态数组）—— 修复 v34「MT 开启后引力波波形/观测失效」。采样节奏与
 * 主线程 physicsAdvance 逐位同构（gwEvery = max(1, ⌊steps/48⌋)，k%gwEvery==0）。
 * v37：轨迹子帧采样 —— o.sub = { tInt, startT } 时按【累计推进时间】阈值采样
 * 真实积分器状态快照（与主线程 physicsAdvance 同一阈值逻辑），随帧回传主线程
 * 写入轨迹环形缓冲（transferable 所有权转移，零拷贝）。大步长快进时每帧仅 1 采样
 * 的轨迹必折线化（月球 6h×1000 实测 9.15 圈/段，密切锥线终点偏差 3×10⁵ km，
 * 预测弧无法还原多体摄动路径）—— 唯一诚实的修复是加密真实采样。
 * v39：快照改【单缓冲打包】—— 旧实现每样本 2 个新 Float32Array + 每帧最多
 * 数千个 transferable 的 postMessage 结构化克隆开销（v39 打通 MT 子帧采样后
 * 每帧样本数可达 2048+，对象/传输开销放大成帧延迟）。现全部样本打包为
 * t: Float64Array(count) + data: Float32Array(count×N×6)（每样本 [pos|vel] 连续
 * 存储），整帧仅 2 个 transferable；主线程按 subarray 零拷贝采纳进环形槽位。 */
function integrateFrame(baseDt, steps, targetTime, o) {
  const isIAS = R.integrator === 'ias15';
  const stepFn = isIAS ? Fn.stepIAS15 : Fn.stepYoshida4;
  const adaptiveOn = isIAS ? true : o.adaptive;
  const gwEvery = o.gwEvery || 0;
  const gwBuf = gwEvery ? [] : null;
  const sub = o.sub || null;                      /* v37：{ tInt, startT } | null */
  /* v39：打包快照缓冲（倍增式增长；count×N×6 f32，每样本 [pos|vel] 连续） */
  let sCap = 0, sN = 0, sT = null, sD = null;
  const snap = () => {
    if (sN === sCap) {
      const nc = sCap ? sCap * 2 : 32;
      const nt = new Float64Array(nc); if (sT) nt.set(sT);
      const stride = R.N * 6;
      const nd = new Float32Array(nc * stride);
      if (sD) nd.set(sD.subarray(0, sN * stride));
      sT = nt; sD = nd; sCap = nc;
    }
    /* 经 R.arrs() 取当前数组视图（Node eval 垫片下裸全局词法绑定不可见，双环境安全） */
    const A = R.arrs(), n3 = R.N * 3, so = sN * n3 * 2;
    for (let i = 0; i < R.N; i++) {
      sD[so + i * 3] = A.px[i]; sD[so + i * 3 + 1] = A.py[i]; sD[so + i * 3 + 2] = A.pz[i];
      sD[so + n3 + i * 3] = A.vx[i]; sD[so + n3 + i * 3 + 1] = A.vy[i]; sD[so + n3 + i * 3 + 2] = A.vz[i];
    }
    sT[sN] = sub.startT + advanced; sN++;
  };
  let advanced = 0, mergeHit = false;
  let nextSampleT = sub ? sub.tInt : 0;
  const t0 = performance.now();
  let k = 0;
  if (adaptiveOn && R.N > 1) {
    for (; k < 40000 && advanced < targetTime; k++) {
      if ((k & 7) === 7 && performance.now() - t0 > o.budgetMs) break;
      let dtk;
      if (isIAS) dtk = Fn.stepIAS15Adaptive(baseDt);
      else dtk = Fn.advanceAdaptiveYoshida(baseDt);
      advanced += dtk;
      if (sub && advanced >= nextSampleT) { snap(); nextSampleT += sub.tInt; }   /* v37 */
      if (gwBuf && k % gwEvery === 0) {
        const hw = Fn.computeGWStrainCore();   // 自适应路径每步均刷新 ax → 采样有效
        gwBuf.push(hw[0], hw[1]);
      }
      if (o.mergeOn && R.minR2 < o.contactR2) { mergeHit = true; k++; break; }   // v32 语义：接触即停，主线程并合
    }
  } else {
    /* v36：固定步长路径接入墙钟预算（与主线程 physicsAdvance 同构 —— 旧版无预算，
     * MT 快进时编排 worker 一帧占用数百 ms，主线程绘帧间隔同样被拉长）。
     * 预算只截断每帧步数、下帧续派，步序列确定 → 轨迹逐位不变。 */
    for (; k < steps; k++) {
      if ((k & 7) === 7 && performance.now() - t0 > o.budgetMs) break;
      /* v19f：自适应关且无 GW 波形时，步尾统计求值仅在需要处刷新（gw 采样步/末步）；
       * v35：刷新条件与主线程 physicsAdvance 逐位一致（gwK || 末步） */
      const gwK = gwEvery && k % gwEvery === 0;
      stepFn(baseDt, gwK || k === steps - 1 ? true : false);
      advanced += baseDt;
      if (sub && advanced >= nextSampleT) { snap(); nextSampleT += sub.tInt; }   /* v37 */
      if (gwK) {
        const hw = Fn.computeGWStrainCore();
        gwBuf.push(hw[0], hw[1]);
      }
    }
  }
  if (adaptiveOn && R.N > 1) { R.lastAdaptSteps = k; R.lastAdaptAdvanced = advanced; }
  else { R.lastAdaptSteps = 0; R.lastAdaptAdvanced = 0; }
  const res = {
    advanced, mergeHit, k: R.lastAdaptSteps, advancedAdapt: R.lastAdaptAdvanced,
    gw: gwBuf,
    stats: { minR2: R.minR2, maxAccMag: R.maxAccMag, minPairM: R.minPairM, minPairV2: R.minPairV2, tideHeatW: R.tideHeatW },
    ias: { iasDtNext: R.iasDtNext, iasRejectCount: R.iasRejectCount },
    capRev: -1, cap: W.cap
  };
  if (sub && sN) res.samples = { n: R.N, count: sN,
    t: sT.subarray(0, sN), data: sD.subarray(0, sN * R.N * 6) };   /* v39：单缓冲打包回传 */
  return res;
}

async function doInit(msg) {
  W.myW = msg.w;
  W.memory = msg.memory;
  const mod = await WebAssembly.compile(msg.wasm);
  W.inst = new WebAssembly.Instance(mod, { env: { memory: W.memory } });
  W.exp = W.inst.exports;
  /* v34b 修复：worker 不得调 init() —— 常量区/堆指针（heapPtr）与控制块位于共享
   * 线性内存的数据段，init() 会把 heapPtr 重置回 __heap_base，使派发者之后任何
   * bump 分配（BH 树、IAS15 arena、growCap 的新状态块）覆盖已存活状态。
   * initWorker 只写物理常量，不动堆/控制块。 */
  if (W.exp.initWorker) {
    W.exp.initWorker(R.G, R.C_SQ, R.C_5, R.GRAV_SOFTENING_SQ, R.PN_TIDE_R_MIN,
      R.TIDE_LAG_MAX, R.YOSHIDA_W1, R.YOSHIDA_W0);
  } else {
    W.exp.init(R.G, R.C_SQ, R.C_5, R.GRAV_SOFTENING_SQ, R.PN_TIDE_R_MIN,
      R.TIDE_LAG_MAX, R.YOSHIDA_W1, R.YOSHIDA_W0, 0);
  }
  W.exp.setBlock(msg.base, msg.cap);
  W.base = msg.base;
  /* v35：worker 堆隔离 —— 编排 worker 的 bump 指针指向主线程预留的区域
   * （旧版 heapPtr=0：MT+IAS15/BH 时 iasTry/树分配从地址 0 踩踏共享内存）
   * 计算 worker（w≥1）不分配，无需设置。 */
  if (msg.heapPtr && W.exp.setHeapPtr) W.exp.setHeapPtr(msg.heapPtr);
  W.useMT = !!msg.useMT;
  buildViews(msg.cap);
  R.iasReady = false; R.iasN3 = -1; R.iasLastDt = 0; R.iasDtNext = Infinity;
  return true;
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  if (msg.t === 'init') {
    try {
      await doInit(msg);
      self.postMessage({ t: 'ready', w: W.myW });
      if (W.myW > 0) W.exp.workerLoop(W.myW);   // 计算 worker 进入阻塞服务循环
    } catch (err) {
      self.postMessage({ t: 'error', w: msg.w, err: String(err && err.message || err) });
    }
    return;
  }
  if (msg.t === 'cap') {
    W.exp.setBlock(msg.base, msg.cap);
    W.base = msg.base;
    buildViews(msg.cap);
    return;
  }
  if (msg.t === 'reload') {
    R.iasReady = false; R.iasN3 = -1; R.iasLastDt = 0; R.iasDtNext = Infinity; R.iasRejectCount = 0;
    W.lastN = -1;
    return;
  }
  if (msg.t === 'frame') {
    // 同步编排全局（主线程权威）
    R.N = msg.n;
    const fl = msg.flags;
    R.gr1pnOn = fl.gr1pnOn; R.gr25On = fl.gr25On; R.gr2pnOn = fl.gr2pnOn; R.gr35On = fl.gr35On;
    R.gr15spinOn = fl.gr15spinOn; R.tideOn = fl.tideOn; R.integrator = fl.integrator;
    R.j2On = !!fl.j2On; R.pwOn = !!fl.pwOn;   /* v35 */
    R.iasEpsilon = fl.iasEpsilon;
    W.bhTheta = (fl.bhTheta === undefined || fl.bhTheta === null) ? null : fl.bhTheta;
    /* v35：系统更换（N 变化）→ IAS15 预测器/步长控制器冷启动（与主线程 initState 同构；
     * 旧版跨 initState 保留旧预测器 → 新系统首步用旧态外推 → 间歇性发散） */
    if (W.lastN !== undefined && W.lastN !== R.N) {
      R.iasReady = false; R.iasN3 = -1; R.iasLastDt = 0; R.iasDtNext = Infinity; R.iasRejectCount = 0;
    }
    W.lastN = R.N;
    if (msg.cap !== W.cap) { W.exp.setBlock(msg.base, msg.cap); W.base = msg.base; buildViews(msg.cap); }
    const res = integrateFrame(msg.baseDt, msg.steps, msg.targetTime, {
      adaptive: fl.adaptive, mergeOn: msg.mergeOn, contactR2: msg.contactR2, budgetMs: msg.budgetMs,
      gwEvery: fl.gwEvery || 0,
      /* v37：轨迹子帧采样参数（主线程按轨迹开关/帧推进计算；无轨迹时 null） */
      sub: (msg.subT > 0 && R.N > 0) ? { tInt: msg.subT, startT: msg.startT || 0 } : null
    });
    res.seq = msg.seq;
    res.epoch = msg.epoch;   /* v35：状态纪元回传（不匹配 → 主线程整体作弃） */
    res.cap = msg.cap;
    /* v34b 修复：原实现恒发 capRev=0 → 主线程每帧重建全部视图；改为原样回传。 */
    res.capRev = msg.capRev;
    /* v37/v39：快照缓冲所有权转移（零拷贝；单缓冲打包 → 整帧仅 2 个 transferable） */
    const transfers = [];
    if (res.samples) {
      transfers.push(res.samples.t.buffer, res.samples.data.buffer);
    }
    self.postMessage({ t: 'frame', ...res }, transfers);
    return;
  }
  if (msg.t === 'quit') {
    self.close();   // 计算 worker 阻塞在 atomic.wait，由主线程 terminate() 兑底
  }
};
