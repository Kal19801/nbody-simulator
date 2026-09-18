/* physics_engine.js — v34 计算引擎管理器（主线程）
 *
 * 职责：
 *   1. 加载 physics_core.wasm（最多 3 次重试；失败静默回退 JS 内核 —— 需求⑤）
 *   2. WASM 内存接管：状态数组 → wasm 线性内存视图（业务/渲染/导出代码无感）
 *   3. 派发钩子实现：accumDispatch / stepYoshida4 / scanStats / growCap
 *   4. 多线程：physics-worker（帧级 postMessage）+ 计算 worker 池（行分割）
 *   5. 面板 UI：WASM 开关、多线程开关、引擎状态显示
 *
 * 语义承诺：WASM 内核与 JS 内核逐位等价（IEEE754，见 physics_kernel.c 契约），
 * 引擎切换仅搬运状态位，不改变任何物理行为。
 */
(function () {
  'use strict';
  if (window.__ENGINE__) return;   // 幂等

  /* ---------- 内存布局（与 physics_kernel.c 严格一致） ---------- */
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
  ];                                   // 78 个 cap 区
  const N_SEC = 80;                    // 内核 S_COUNT（预留 2 个对齐位）
  const FIX_COUNT = 119;               // 固定区 f64 数
  const FIX_BYTES = FIX_COUNT * 8;     // 952
  const F_STATS = 0, F_MPI = 5, F_LEDGER = 7, F_SCAN = 23;
  const LED_NAMES = ['sinkGWE', 'sinkTideE', 'sinkGWLx', 'sinkGWLv', 'sinkGWLz', 'fieldPx', 'fieldPv', 'fieldPz'];
  const MEM_MAX_PAGES = 32768;         // 2 GB
  const MEM_INIT_PAGES = 64;           // 4 MB
  const WASM_URL = 'physics_core.wasm';
  const WASM_RETRIES = 3;              // 需求⑤：失败多次后静默回退

  const core = window.__NBODY_CORE__;
  const R = core.refs();
  const F = core.fns();

  const E = {
    state: 'idle',        // idle | loading | active | fallback
    active: false,        // ensureCap/accumulateAccel 钩子的开关
    mtOn: false,
    mtAvail: false,
    poolReady: false,
    workers: [],
    nWorkers: 0,
    wasm: null,
    memory: null,
    wasmBytes: null,
    cap: 0,
    capRev: 0,
    statsView: null,
    mpiView: null,
    scanView: null,
    dispatchSeq: 0,
    pending: null,        // MT 帧派发回调
    lastError: null
  };
  window.__ENGINE__ = E;

  function crossOriginIsolated() {
    return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
  }

  function mask() {
    return (R.gr1pnOn ? 1 : 0) | (R.gr15spinOn ? 2 : 0) | (R.gr2pnOn ? 4 : 0) |
      (R.gr25On ? 8 : 0) | (R.gr35On ? 16 : 0) | (R.tideOn ? 32 : 0) |
      (R.j2On ? 64 : 0) | (R.pwOn ? 128 : 0);   /* v35：J2/PW 独立位 */
  }

  /* ---------- 视图构建：把核心全局绑定接到 wasm 内存 ---------- */
  function buildViews(cap) {
    const buf = E.memory.buffer;
    const base = E.wasm.exports.getBlkBase();
    const arrs = {};
    SEC_ORDER.forEach((name, s) => {
      arrs[name] = new Float64Array(buf, base + FIX_BYTES + s * cap * 8, cap);
    });
    // mpSpin 之后两个对齐保留位（S_COUNT=80 与 JS 78 之差）不建视图
    R.setArrs(arrs);
    const led = {};
    LED_NAMES.forEach((name, k) => {
      led[name] = new Float64Array(buf, base + (F_LEDGER + k * 2) * 8, 2);
    });
    R.setLedgers(led);
    E.statsView = new Float64Array(buf, base + F_STATS * 8, 5);
    E.mpiView = new Float64Array(buf, base + F_MPI * 8, 2);
    E.scanView = new Float64Array(buf, base + F_SCAN * 8, 8);
    E.iasRetView = new Float64Array(buf, base + 31 * 8, 1);   /* v34b: F_WPART+0（iasTry dtNext 回传位，与 rowsJob 时序不重叠） */
    E.cap = cap;
    E.capRev++;
    R.bufVer = R.bufVer + 1;   // 包装数组缓存失效（v19f 机制复用）
  }

  /* ---------- 状态迁移（位级拷贝，切换引擎前后逐位一致） ---------- */
  function snapshotJS() {
    const a = R.arrs(), n = R.CAP, out = { n, cap: R.CAP, arrays: {}, ledgers: {}, stats: {} };
    SEC_ORDER.forEach(k => {
      const src = a[k];
      const c = new Float64Array(n);
      if (src) c.set(src.subarray(0, n));
      out.arrays[k] = c;
    });
    const l = R.ledgers();
    LED_NAMES.forEach(k => { out.ledgers[k] = [l[k][0], l[k][1]]; });
    out.stats = { minR2: R.minR2, maxAccMag: R.maxAccMag, minPairM: R.minPairM, minPairV2: R.minPairV2, tideHeatW: R.tideHeatW };
    return out;
  }
  function restoreToJS(snap) {
    const fresh = {};
    SEC_ORDER.forEach(k => { fresh[k] = snap.arrays[k]; });
    R.setArrs(fresh);
    const led = {};
    LED_NAMES.forEach(k => { led[k] = snap.ledgers[k]; });   // 普通数组（JS 回退原语义）
    R.setLedgers(led);
    R.minR2 = snap.stats.minR2; R.maxAccMag = snap.stats.maxAccMag; R.minPairM = snap.stats.minPairM;
    R.minPairV2 = snap.stats.minPairV2; R.tideHeatW = snap.stats.tideHeatW;
    R.bufVer = R.bufVer + 1;
  }

  /* ---------- ensureCap 钩子路径 ----------
   * v35 内存泄漏修复：旧实现无 n<=cap 短路 —— 每次 initState（ensureCap 被调两次）
   * 都无条件 blkResize 且 newCap = max(n, cap*2) 强制翻倍 → 反复加载/切换预设时
   * wasm 状态块与内存页指数增长（64→128→…，实测可达 GB 级）。现与 JS 内核
   * ensureCap 同语义：容量足够时零操作。 */
  E.growCap = function (n) {
    if (!E.active) { F.ensureCap(n); return; }
    if (n <= E.cap) return;   /* v35：容量足够 → 零操作（与 JS ensureCap 同语义） */
    // 计算新块所需字节并先扩展 wasm 内存
    const newCap = Math.max(n, E.cap ? E.cap * 2 : 64);
    const needBytes = FIX_BYTES + N_SEC * newCap * 8 + 16;
    const heapPtr = E.wasm.exports.getHeapPtr();
    const pages = Math.ceil(Math.max(0, heapPtr + needBytes - E.memory.buffer.byteLength) / 65536);
    if (pages > 0) E.memory.grow(pages);
    E.wasm.exports.blkResize(newCap);
    buildViews(newCap);
    R.CAP = newCap;
    /* v34b：IAS15 预测器缓冲随 cap 重建 → JS 语义为冷启动（iasEnsureBuffers 置
     * iasReady=false/iasN3=-1），引擎路径必须镜像，否则扩容后预测器继续用旧状态。 */
    R.iasReady = false; R.iasN3 = -1;
    if (E.poolReady) {
      const base = E.wasm.exports.getBlkBase();
      E.workers.forEach(wk => wk.postMessage({ t: 'cap', base, cap: newCap, capRev: E.capRev }));
    }
  };

  /* ---------- accumulateAccel 钩子路径 ---------- */
  E.bhTheta = null;   // null = 精确模式；0.6/0.9 = Barnes-Hut 近场树
  E.accumDispatch = function () {
    const n = R.N, m = mask();
    if (E.bhTheta && n >= 512) E.wasm.exports.accumBH(n, m, E.bhTheta);
    else if (E.mtOn && E.poolReady && n >= 256) E.wasm.exports.accumMT(n, m);
    else E.wasm.exports.accumST(n, m);
    E.statsView && syncStatsFromView();
  };
  function syncStatsFromView() {
    R.minR2 = E.statsView[0]; R.maxAccMag = E.statsView[1]; R.minPairM = E.statsView[2];
    R.minPairV2 = E.statsView[3]; R.tideHeatW = E.statsView[4];
  }

  /* ---------- stepYoshida4 钩子路径 ---------- */
  E.stepYoshida4 = function (h, refresh) {
    const a = R.YOSHIDA_W1 * h, b = R.YOSHIDA_W0 * h;
    const fast = !R.gr1pnOn && !R.gr25On && !R.gr2pnOn && !R.tideOn;
    if (fast) E.wasm.exports.yoshFast(a, b, R.N, mask());
    else E.wasm.exports.yoshPN(a, b, R.N, mask(), refresh ? 1 : 0);
    syncStatsFromView();
    R.mpIterLast = E.mpiView[0]; R.mpConvLast = E.mpiView[1] !== 0;
    return fast ? true : R.mpConvLast;
  };

  /* ---------- scanPairStats 钩子路径 ---------- */
  E.scanStats = function (useMid, out) {
    E.wasm.exports.scanStats(R.N, mask(), useMid ? 1 : 0, useMid ? 1 : 0);
    const off = useMid ? 4 : 0;
    out.minR2 = E.scanView[off + 0]; out.minPairM = E.scanView[off + 1];
    out.minPairV2 = E.scanView[off + 2]; out.spinCoef = E.scanView[off + 3];
    return out;
  };

  /* ---------- v34b: IAS15 整步钩子（iasTry 逐位移植） ----------
   * R.iasReady=false（activate/growCap/initState 后）→ iasReset 冷启动，
   * 与 JS 备份路径状态机一致；iasLastDt/iasRejectCount 由本侧维护。 */
  E.iasStepTry = function (h, refresh, fixed) {
    if (!R.iasReady) { E.wasm.exports.iasReset(); R.iasReady = true; }
    const acc = E.wasm.exports.iasTry(R.N, h, mask(), fixed ? 1 : 0, refresh !== false ? 1 : 0,
      R.iasLastDt, R.iasEpsilon, R.IAS_ADAPTIVE_MODE);
    const dtNext = E.iasRetView ? E.iasRetView[0] : h;
    if (acc) R.iasLastDt = h; else R.iasRejectCount++;
    syncStatsFromView();
    return { acc: acc === 1, dtNext };
  };

  /* ---------- WASM 加载（3 次重试，失败静默回退） ---------- */
  async function loadWasm() {
    if (!E.wasmBytes) {
      console.info('fetch wasm...');
      const res = await fetch(WASM_URL);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      E.wasmBytes = await res.arrayBuffer();
      console.info('wasm bytes:', E.wasmBytes.byteLength);
    }
    E.memory = new WebAssembly.Memory({ initial: MEM_INIT_PAGES, maximum: MEM_MAX_PAGES, shared: true });
    console.info('compiling...');
    const mod = await WebAssembly.compile(E.wasmBytes);
    console.info('compiled, instantiating...');
    const imports = WebAssembly.Module.imports(mod);
    const env = {};
    for (const im of imports) {
      if (im.kind === 'memory') env[im.name] = E.memory;
      else if (im.kind === 'global') env[im.name] = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
      else if (im.kind === 'function') env[im.name] = () => { throw new Error('unreachable import: ' + im.name); };
      else if (im.kind === 'table') env[im.name] = new WebAssembly.Table({ initial: 0, element: 'anyfunc' });
    }
    const inst = await new WebAssembly.Instance(mod, { env });
    console.info('instantiated, version=', inst.exports.version());
    return inst;
  }
  async function activate() {
    if (E.active) return true;
    if (E.state === 'loading') return false;
    E.state = 'loading';
    let inst = null, lastErr = null;
    for (let attempt = 1; attempt <= WASM_RETRIES; attempt++) {
      try { inst = await loadWasm(); break; }
      catch (err) { lastErr = err; E.wasmBytes = null; console.info('尝试 ' + attempt + ' 失败:', String(err && err.message || err)); await new Promise(r => setTimeout(r, 150 * attempt)); }
    }
    if (!inst) {
      /* 静默回退 JS（不弹窗不打断；面板显示状态，console 留痕） */
      E.state = 'fallback'; E.active = false; E.lastError = String(lastErr && lastErr.message || lastErr);
      console.info('WASM 内核加载失败，已回退 JS 内核：', E.lastError);
      updateStatus();
      return false;
    }
    E.wasm = inst;
    const v = inst.exports.version();
    if (v !== 36) { E.state = 'fallback'; E.lastError = '内核版本不匹配: ' + v; return false; }
    inst.exports.init(R.G, R.C_SQ, R.C_5, R.GRAV_SOFTENING_SQ, R.PN_TIDE_R_MIN,
      R.TIDE_LAG_MAX, R.YOSHIDA_W1, R.YOSHIDA_W0, Math.max(R.CAP, 64));
    const snap = snapshotJS();           // 先带走当前状态（JS 数组或旧视图）
    buildViews(Math.max(R.CAP, 64));     // 再建视图
    R.CAP = E.cap;
    // 状态位级写入 wasm 内存
    const a = R.arrs();
    SEC_ORDER.forEach(k => {
      const dst = a[k], src = snap.arrays[k];
      dst.set(src.subarray(0, R.N));
      for (let i = R.N; i < E.cap; i++) dst[i] = 0;
    });
    const led = R.ledgers();
    LED_NAMES.forEach(k => { led[k][0] = snap.ledgers[k][0]; led[k][1] = snap.ledgers[k][1]; });
    E.statsView[0] = snap.stats.minR2; E.statsView[1] = snap.stats.maxAccMag; E.statsView[2] = snap.stats.minPairM;
    E.statsView[3] = snap.stats.minPairV2; E.statsView[4] = snap.stats.tideHeatW;
    // IAS15 预测器重置（引擎切换一步冷启动，不改变物理语义）
    R.iasReady = false; R.iasN3 = -1; R.iasLastDt = 0; R.iasDtNext = Infinity;
    E.active = true; E.state = 'active';
    E.mtAvail = crossOriginIsolated();
    updateStatus();
    return true;
  }

  async function deactivate() {
    if (!E.active) return;
    stopPool();
    const snap = snapshotJS();
    E.active = false; E.state = 'fallback';
    restoreToJS(snap);
    R.iasReady = false; R.iasN3 = -1; R.iasLastDt = 0; R.iasDtNext = Infinity;
    updateStatus();
  }

  /* ---------- 多线程池 ---------- */
  function postPool(msg, transfer) {
    if (E.workers[0]) E.workers[0].postMessage(msg, transfer || []);
  }

  /* v35：编排 worker 堆区预留（每次引擎激活预留一次，池重启复用；纯指针预留，
   * 不预提交内存 —— worker 实际分配时才按需 memory.grow） */
  function workerHeapBase() {
    if (!E.workerHeapBase && E.wasm && E.wasm.exports.reserveHeap) {
      E.workerHeapBase = E.wasm.exports.reserveHeap(536870912);   /* 512 MB 指针空间 */
    }
    return E.workerHeapBase || 0;
  }

  async function startPool() {
    if (E.poolReady || !E.active) return;
    if (!crossOriginIsolated()) { uncheckMT(); showToastSafe('多线程需要跨域隔离。当前环境仅单线程 WASM。', 'info'); E.mtOn = false; updateStatus(); return; }
    const hw = (navigator.hardwareConcurrency || 4);
    /* v37：线程数留 1 核余量（hw-1）—— 旧 W = hw 时播放中 W 个计算线程全速运转，
     * 主线程/合成器/rAF 与 OS 调度争核（用户报告「多线程更卡顿」的次要来源）。
     * 行分割结果与 W 无关（确定性），只影响并行度不影响物理。下限 2 不变。 */
    const W = Math.max(2, Math.min(hw - 1, 16));
    E.workers = [];
    try {
      await new Promise((resolve, reject) => {
        let ready = 0, failed = false;
        for (let w = 0; w < W; w++) {
          const wk = new Worker('physics_worker.js');
          wk.onmessage = (ev) => {
            if (ev.data && ev.data.t === 'ready') {
              ready++;
              if (ready === W && !failed) { E.poolReady = true; E.nWorkers = W; resolve(); }
            } else if (ev.data && ev.data.t === 'frame') {
              onFrameResult(ev.data);
            }
          };
          wk.onerror = (e) => {
            /* v35：池运行期错误 → 释放挂起帧（下一帧自动回退主线程），不再永久卡死渲染循环 */
            if (!failed) { failed = true; reject(new Error(e.message || 'worker error')); return; }
            if (E.frameInFlight) { E.frameInFlight = false; E.pending = null; console.info('worker 错误，帧已作弃：', e.message); }
          };
          wk.postMessage({ t: 'init', w, wasm: E.wasmBytes, memory: E.memory,
            base: E.wasm.exports.getBlkBase(), cap: E.cap, useMT: true,
            heapPtr: w === 0 ? workerHeapBase() : 0 });   /* v35：w0 堆隔离 */
          E.workers.push(wk);
        }
      });
      E.poolReady = true; E.nWorkers = W;
    } catch (err) {
      console.info('线程池创建失败，回退单线程 WASM：', err);
      stopPool();
      E.mtOn = false;
      uncheckMT();
    }
    updateStatus();
  }
  /* v34b：池不可用时把开关 UI 同步回关闭（旧实现只改内部状态，复选框仍显示勾选） */
  function uncheckMT() {
    const mt = document.getElementById('mtToggle');
    if (mt) mt.checked = false;
  }
  function stopPool() {
    if (E.workers.length) {
      try { postPool({ t: 'quit' }); } catch (e) { }
      E.workers.forEach(w => { try { w.terminate(); } catch (e) { } });
    }
    E.workers = []; E.poolReady = false; E.nWorkers = 0;
    /* v35：池终止时释放挂起帧 —— 若在播放中关闭多线程，在飞帧永不回巢会卡死
     * 渲染循环；done(null) 让调用方走主线程 physicsAdvance 兑底路径续帧 */
    if (E.frameInFlight && E.pending) {
      const done = E.pending;
      E.frameInFlight = false; E.pending = null;
      try { done(null); } catch (e) { }
    }
    E.frameInFlight = false; E.pending = null;
  }

  /* ---------- MT 帧派发 ----------
   * v35：状态纪元（stateEpoch）—— initState/并合改写共享状态期间，在飞帧的
   * 结果一律作弃（根因修复「切换预设后偶发发散」：旧版 worker 边积分旧态、
   * 主线程边写新态 → 竞态写坏 + worker IAS 状态机跨 initState 不复位）。 */
  E.stateEpoch = 0;
  E.frameInFlight = false;
  E.pendingInit = null;
  /* v35：initState 前调用 —— 在飞帧标记作弃；若有挂起的 initState 重写，
   * 结果回巢后由 onFrameResult 统一重放（避免 worker 晚到写坏新状态）。 */
  E.invalidateFrames = function () {
    E.stateEpoch++;
    if (E.frameInFlight) return true;   // 有在飞帧：调用方应改走 deferred 路径
    postPool({ t: 'reload' });          // v35：无在飞帧也通知 worker 复位 IAS 状态机
    return false;
  };
  E.advanceAsync = function (baseDt, steps, targetTime, opts, done) {
    if (!E.poolReady) { done(null); return; }
    E.pending = done;
    E.frameInFlight = true;
    E.dispatchSeq++;
    postPool({
      t: 'frame', seq: E.dispatchSeq, epoch: E.stateEpoch, baseDt, steps, targetTime,
      base: E.wasm ? E.wasm.exports.getBlkBase() : 0,
      n: R.N, flags: {
        gr1pnOn: R.gr1pnOn, gr25On: R.gr25On, gr2pnOn: R.gr2pnOn, gr35On: R.gr35On,
        gr15spinOn: R.gr15spinOn, tideOn: R.tideOn, j2On: R.j2On, pwOn: R.pwOn,
        integrator: R.integrator,
        iasEpsilon: R.iasEpsilon, adaptive: opts.adaptive,
        bhTheta: E.bhTheta,          /* v34b: BH 选择随帧传递（worker 侧同规则派发 accumBH） */
        gwEvery: opts.gwEvery || 0   /* v35：MT 引力波采样节奏（与 physicsAdvance 同式） */
      },
      mergeOn: opts.mergeOn, contactR2: opts.contactR2, budgetMs: opts.budgetMs,
      cap: E.cap, capRev: E.capRev
    });
  };
  function onFrameResult(msg) {
    E.frameInFlight = false;
    /* v35：状态纪元不匹配 = initState 已改写系统 → 结果整体作弃（防竞态污染） */
    if (msg.epoch !== undefined && msg.epoch !== E.stateEpoch) {
      E.pending = null;
      const pi = E.pendingInit; E.pendingInit = null;
      if (pi && typeof window.initStateFull === 'function') {
        /* worker 已停写（帧结束）→ 现在重放 initState 的状态写入（干净） */
        initStateFull(pi);
        postPool({ t: 'reload' });   // worker 侧 IAS 状态机/统计复位
        /* v37：重放路径补跑系统替换后处理（贴图记忆重附/材质库自动应用/场景重扫/）
         * —— 旧版只调 uiAfterState，MT 在飞帧期间切换预设时 matAutoApply/贴图
         * 重附被跳过 → 贴图丢失（直接路径 setSystem 有做，此处对齐） */
        if (typeof window.afterSystemReplaced === 'function') window.afterSystemReplaced();
        else if (typeof window.uiAfterState === 'function') window.uiAfterState();
      }
      return;
    }
    const done = E.pending; E.pending = null;
    if (!done) return;
    /* v34b 修复：worker 原样回传 capRev；旧实现 worker 恒发 capRev=0，
     * 与主线程（buildViews 后 ≥1）永不相等 → 每帧重建 78 个视图（浪费 + GC 压力）。 */
    if (msg.capRev !== E.capRev || msg.cap !== E.cap) { buildViews(msg.cap); R.CAP = msg.cap; }
    R.minR2 = msg.stats.minR2; R.maxAccMag = msg.stats.maxAccMag; R.minPairM = msg.stats.minPairM;
    R.minPairV2 = msg.stats.minPairV2; R.tideHeatW = msg.stats.tideHeatW;
    R.lastAdaptSteps = msg.lastAdaptSteps; R.lastAdaptAdvanced = msg.lastAdaptAdvanced;
    R.iasDtNext = msg.ias.iasDtNext; R.iasRejectCount = msg.ias.iasRejectCount;
    done(msg);
  }

  function showToastSafe(txt, kind) {
    try { if (typeof window.showToast === 'function') showToast(txt, kind || 'info', 4000); } catch (e) { }
  }

  /* ---------- UI ---------- */
  function updateStatus() {
    const el = document.getElementById('engineStatus');
    if (!el) return;
    let txt;
    if (E.state === 'active') {
      const threads = E.mtOn && E.poolReady ? (E.nWorkers + ' 线程') : '单线程';
      const bh = E.bhTheta ? ' · BH θ=' + E.bhTheta : '';
      /* v36：内核版本动态取自 wasm version()（内核 v35 不变）；应用层 v36 */
      txt = 'WASM 内核 ' + ' · ' + threads + bh + (E.lastError ? '曾回退：' + E.lastError + '' : '');
    } else if (E.state === 'loading') txt = 'WASM 加载中…';
    else if (E.state === 'fallback') txt = 'JS 内核';
    else txt = 'JS 内核';
    el.textContent = txt;
    const mt = document.getElementById('mtToggle');
    if (mt) {
      mt.disabled = !(E.active && (crossOriginIsolated() || E.poolReady));
      mt.parentElement.title = mt.disabled ? '需要跨域隔离（COOP/COEP，经 coi-serviceworker 注入）' : '行分割并行（SharedArrayBuffer + Atomics）';
    }
  }

  function wireUI() {
    const w = document.getElementById('wasmToggle');
    const m = document.getElementById('mtToggle');
    if (w) {
      w.addEventListener('change', async () => {
        if (w.checked) {
          const ok = await activate();
          if (ok && m && m.checked) { E.mtOn = true; await startPool(); }
        } else {
          E.mtOn = false;
          await deactivate();
        }
        updateStatus();
      });
      /* v34b 修复：多核开关打开后仍显示单核 —— E.mtOn 此前从未被置 true，
       * 导致 accumDispatch / 帧派发 / 状态显示三处全部静默退回单线程。
       * 现按开关当前态同步意图标志（含页面初载即勾选的场景）。 */
      if (w.checked) activate().then(ok => {
        if (ok && m && m.checked) { E.mtOn = true; startPool(); }
        updateStatus();
      });
    }
    if (m) {
      m.addEventListener('change', async () => {
        if (!E.active) { if (w && w.checked) await activate(); else { m.checked = false; showToastSafe('多线程需要 WASM 内核', 'info'); return; } }
        E.mtOn = m.checked;   /* v34b 修复（同上）：意图标志与开关同步 */
        if (m.checked) await startPool(); else stopPool();
        updateStatus();
      });
      if (m.checked && E.active) { E.mtOn = true; startPool(); }
    }
    const bh = document.getElementById('bhSelect');
    if (bh) {
      bh.addEventListener('change', () => {
        const v = bh.value;
        E.bhTheta = v === 'off' ? null : parseFloat(v);
        updateStatus();
      });
    }
    updateStatus();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireUI);
  else wireUI();
})();
