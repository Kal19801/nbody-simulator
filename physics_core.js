/* physics_core.js — v34 物理内核（自 nbody_gr_simulator_v33_1.html 原样外置）
 * 生成方式：scripts/extract_core.py 按区间逐行切出。
 * 用途：
 *   ① 主页面 <script src> —— WASM 不可用时的回退计算路径（原行为逐位一致）；
 *   ② physics_worker.js 经 importScripts —— 多线程模式下积分器跑在 worker 内；
 *   ③ Node 测试台架（vm.runInThisContext）—— 保证"所测即所发"。
 * v34 派发钩子：仅 4 处函数入口（ensureCap/accumulateAccel/stepYoshida4/scanPairStats），
 * 引擎未激活时全部直落原始实现。 */
'use strict';


/* ===== 物理核区块 HTML L899-L1043（原样） ===== */

/* ---------------- 常量 ---------------- */
const G  = 6.67430e-11;              // 万有引力常数 m^3 kg^-1 s^-2
const C_LIGHT = 299792458;           // 光速 m/s
const C_SQ = C_LIGHT * C_LIGHT;
const C_5  = C_SQ * C_SQ * C_LIGHT;
const M_SUN = 1.989e30, M_JUPITER = 1.898e27, M_EARTH = 5.972e24;
const AU = 1.496e11, DAY_SEC = 86400, YEAR_SEC = 365.25 * DAY_SEC, CENTURY_SEC = 100 * YEAR_SEC;
const LY = 9.4607304725808e15;
const GRAV_SOFTENING_SQ = 1e-20;                       // 引力软化（防除零），与原版一致
const ADAPTIVE_ETA = 0.002;                            /* v32：0.001→0.002。辛相误差每轨 ~2e-10 仍远低于需求；
                                                        * 实测弱场偏心/BBH 并合 ~2× 提速；强场近星点仍由判据 4/4b 接管 */
const ADAPTIVE_ETA_SPIN = 0.01;                        // 自适应步长自转判据系数（每步 |ΔΩ| ≤ η·(|Ω|+ω_dyn)）
const ADAPTIVE_SOFT_SQ = (0.001 * AU) * (0.001 * AU);  // 自适应步长最小距离软化
const ARCSEC_PER_RAD = 206264.80624709636;
/* ---------------- v6 潮汐力学 / 引力波常量 ----------------
 * TIDE_GYRATION：自转惯量系数 I = k_r·m·R²（分化地球 0.3308，均匀球 0.4，取 0.33）
 * TIDE_LAG_MAX：平衡潮滞后位移上限（弧度）。CTL 线性展开仅对小时滞有效，
 *   超出时按比例缩减滞后项（物理上等价于饱和到 ~23°，防快自转+密近轨道发散）
 * TIDE_K2_DEFAULT：洛夫数 k2 缺省（类地行星 0.25–0.3，中子星 ≈0.09，气巨 0.3–0.6）
 * PN_TIDE_R_MIN：1PN/2.5PN/潮汐力施加的最小距离（1 cm，防 r→0 数值奇异；
 *   碰撞合并开启时天体先于该距离合并）
 * GW_DIST_MPC：引力波波形面板的标称观测距离（h ∝ 1/D 换算） */
const TIDE_GYRATION = 0.33;
const TIDE_LAG_MAX = 0.4;
const TIDE_K2_DEFAULT = 0.3;
/* v19e 八极洛夫数比：k3 = k2/3。锚定 n=1 多方球 k3/k2≈0.33（Yip et al. 2017, MNRAS 468；
 * NS 量级一致，Damour & Nagar 2009）。不对称高阶潮（近/远侧不对称）力 ∝ r⁻⁹，
 * 相对四极潮比值 = (8/6)·(k3/k2)·(R/r)² ≈ 0.44·(R/r)²，仅在近距交会/并合时生效。 */
/* v22 潮汐高阶项完备性论证（查论文结论，用户 v23 反馈）：
 * 现有平衡潮级数 U_l = −k_l·G·m′²·R^(2l+1)/r^(2l+2)（P_l(cosΨ=1) 径向精确，
 * 伴星位于潮汐轴上时 (2l+2) 次幂导数给出径向力）：
 *   l=2 四极：F = −6k₂Gm′²R⁵/r⁷（已实现，Mignard/Hut 1981 CTL 耗散配套）；
 *   l=3 八极：F = −8k₃Gm′²R⁷/r⁹（v19e 已实现，k3/k2≈1/3 锚 Yip+2017 MNRAS 468,
 *             "Tidal Love numbers and moment–Love relations of polytropic stars"）；
 *   l=4 十六极：F = −10k₄Gm′²R⁹/r¹¹，相对四极比值 = (10/6)(k4/k2)(R/r)⁴。
 *     量级评估（k4/k2 ~ 0.2–0.35，dos Santos Raposo 2016 多方球 l=2..7 数值表）：
 *     月球近地点 R/r = 0.018 → 比值 ~1e-7；密近交会 R/r = 0.3 → ~0.4%；
 *     R/r > 0.4 已进入并合拖曳区（接触模型取代平衡潮展开）。故 l=4 恒低于
 *     积分器误差与拖曳模型不确定度，不实现（省一对对称力项与账本复杂度）；
 *     l=3 滞后耗散相对四极滞后为 (k3/k2)(R/r)² 量级（v19e 已论证），同略。
 *   参考频率依赖 k2（Lainey+2024 土星 k2 频谱）超出恒定 Δt CTL 模型范畴，从略。 */
const TIDE_K3_RATIO = 1 / 3;                           // 仅用于无质量/无半径的退化兜底
/* v7 潮汐耗散缺省 Q 表（按天体类别；Δt = 1/(Q·n(10R))，n(10R)=√(GM/(10R)³)）
 * 锚点：地球海潮有效 Q≈12 → Δt=600s（复现月退 3.8 cm/yr）；
 * 恒星 Zahn 平衡潮 Q≈1e6；气巨 Q≈1.5e4（木 1.1e5 与土 1682 的对数中值）；
 * 中子星 Q≈1e6@kHz；黑洞 Δt=0（视界无潮汐耗散） */
const TIDE_Q_STAR = 1e6, TIDE_Q_GIANT = 1.5e4, TIDE_Q_NS = 1e6, TIDE_Q_BD = 1e5;
const PN_TIDE_R_MIN = 1e-2;
const PN_DT_ETA = 0.022;                                // 强场 PN 步长系数（×GM/c³，见 calcAdaptiveDt）
/* v19f：极强场加密（并合末段防“泵能弹走”）。
 * 【v32 修订】原指数 PN_DEEP_EXP=4.0 是针对 v30 非可逆调度的泵能机制调校的；
 * v31 可逆中点调度已从机制上消除该泵能（见 advanceAdaptiveYoshida 注释），
 * 加密律仅作分辨率保守余量。实测（Node 64 位台架，BBH 36+29M☉ @35Hz）：
 * 指数 4.0 时 plunge 段 dt 比 IAS15 误差驱动步长保守 ~340×（单次并合 >3×10⁶ 步，
 * 交互体验为「合并末端卡死/时间流速骤降」）；改为指数 1.5（γ=γ0 处连续、常数
 * 不变）后并合步数下降 ~20×，2.5PN 啁啾相位误差每轨仍 ≤1e-11（T40/T47 验收）。
 * γ≤γ0 完全不触发（行星/BBH 预设零影响）。
 * 旧判据背景：dt = 0.022·dynT·γ^1.5 ≡ 0.022·(GM/c³)（与 γ 无关，深度盲）：γ≤0.03 已验证优良
 * （BBH 预设/T13），但 v30 非可逆调度下 γ≳0.08 后 1PN 滞后噪声×2.5PN 耗散每轨泵能超过物理
 * 衰减（实测 dt=3e-8→净误差−0.14%，3e-7→+3.9%，3e-6→+31%）——该机制 v31 起已根除（T45 复验）。 */
const PN_GAMMA_DEEP = 0.03;
const PN_DEEP_EXP = 1.5;
const PN_DEEP_ETA = 0.037;
const GW_DIST_MPC = 100;
const GW_MAX_SAMPLES = 2048;
const YOSHIDA_W1 = 1 / (2 - Math.cbrt(2));
const YOSHIDA_W0 = -Math.cbrt(2) * YOSHIDA_W1;         // Yoshida(1990) 4阶系数
/* ---------------- v21：IAS15（Rein & Spiegel 2015, MNRAS 446, 1424；Everhart 1985） ----------------
 * 15 阶 Gauss-Radau 预测-校正积分器，替换原 2 阶 Verlet 选项（Yoshida 4 阶仍为默认）。
 * 常数表逐位转录自 REBOUND 5.1.1 src/integrator_ias15.c（发布值）；
 * IAS_W 为 ∫₀¹ 拉格朗日基积分权重（mpmath 60 位生成，与 REBOUND w[8]/2 精确一致，
 * 用于步内账本/自旋/力矩的 Radau 加权积分）。Python 验证
 * scripts/v21_physics_test.py A：e=0.9 两周期 ΔE=5e-13、200 周期 6e-12、
 * e=0.99+dt 突变 2e-12、1PN 速度相关力收敛、动量 6e-16。 */
const IAS_H = [0.0, 0.0562625605369221464656521910318, 0.180240691736892364987579942780,
  0.352624717113169637373907769648, 0.547153626330555383001448554766,
  0.734210177215410531523210605558, 0.885320946839095768090359771030,
  0.977520613561287501891174488626];                      // 累积 Radau 间隔（x₀=0）
const IAS_RR = [0.0562625605369221464656522, 0.1802406917368923649875799, 0.1239781311999702185219278,
  0.3526247171131696373739078, 0.2963621565762474909082556, 0.1723840253762772723863278,
  0.5471536263305553830014486, 0.4908910657936332365357964, 0.3669129345936630180138686,
  0.1945289092173857456275408, 0.7342101772154105315232106, 0.6779476166784883850575584,
  0.5539694854785181665356307, 0.3815854601022408941493028, 0.1870565508848551485217621,
  0.8853209468390957680903598, 0.8290583863021736216247076, 0.7050802551022034031027798,
  0.5326962297259261307164520, 0.3381673205085403850889112, 0.1511107696236852365671492,
  0.9775206135612875018911745, 0.9212580530243653554255223, 0.7972799218243951369035945,
  0.6248958964481178645172667, 0.4303669872307321188897259, 0.2433104363458769703679639,
  0.0921996667221917338008147];                            // 节点差分 h[j]−h[k]
const IAS_C = [-0.0562625605369221464656522, 0.0101408028300636299864818, -0.2365032522738145114532321,
  -0.0035758977292516175949345, 0.0935376952594620658957485, -0.5891279693869841488271399,
  0.0019565654099472210769006, -0.0547553868890686864408084, 0.4158812000823068616886219,
  -1.1362815957175395318285885, -0.0014365302363708915424460, 0.0421585277212687077072973,
  -0.3600995965020568122897665, 1.2501507118406910258505441, -1.8704917729329500633517991,
  0.0012717903090268677492943, -0.0387603579159067703699046, 0.3609622434528459832253398,
  -1.4668842084004269643701553, 2.9061362593084293014237913, -2.7558127197720458314421588]; // gΔ→b 单项式修正
const IAS_D = [0.0562625605369221464656522, 0.0031654757181708292499905, 0.2365032522738145114532321,
  0.0001780977692217433881125, 0.0457929855060279188954539, 0.5891279693869841488271399,
  0.0000100202365223291272096, 0.0084318571535257015445000, 0.2535340690545692665214616,
  1.1362815957175395318285885, 0.0000005637641639318207610, 0.0015297840025004658189490,
  0.0978342365324440053653648, 0.8752546646840910912297246, 1.8704917729329500633517991,
  0.0000000317188154017613665, 0.0002762930909826476593130, 0.0360285539837364596003871,
  0.5767330002770787313544596, 2.2485887607691597933926895, 2.7558127197720458314421588]; // b→g 预测
const IAS_W = [0.015625, 0.0926790774014896393, 0.152065310323392564, 0.188258772694559278,
  0.195786083726246797, 0.17350739781725064, 0.124823950664932482, 0.0572544073721285997]; // ∫₀¹拉格朗日基
const IAS_EPS = 1e-9;              // Rein-Spiegel 步长监控目标（默认同 REBOUND）
/* v31 IAS15 自适应步长（REBOUND integrator_ias15.c 全套移植，见 stepIAS15Adaptive）：
 * IAS_ADAPTIVE_MODE：0 = PRS23（Pham-Rein-Spiegel 2024，2024-01 起的 REBOUND 默认判据，
 *                    以 a/jerk/snap 估计力变化时标）；1 = GLOBAL（Rein & Spiegel 2015
 *                    原始判据 err = max|b₆|/max|a_end|，含慢变加速度滤除）。
 * IAS_SAFETY = 0.25：相邻步最大增/减因子（REBOUND safety_factor）；步长欲缩 >4× 时
 *                    整步拒绝回滚重做（防大步误差污染），欲增 >4× 时封顶。
 * IAS_MIN_DT：步长绝对地板（REBOUND min_dt 默认 0；此处取 1e-13 s 防 r→0 死锁，
 *             与 Yoshida 路径深场地板一致），地板同时保证拒绝循环几何收敛必终止。
 * iasEpsilon：运行时可写（测试用）；= 0 时关闭自适应走固定步长（同 REBOUND
 *             ias15.epsilon = 0 语义）。 */
const IAS_ADAPTIVE_MODE = 0;       // 默认对齐现行 REBOUND（PRS23）
const IAS_SAFETY = 0.25;
const IAS_MIN_DT = 1e-13;
let iasEpsilon = IAS_EPS;
let iasDtNext = Infinity;          // 控制器维护的「下一步建议步长」（上限 = 用户步长）
let iasRejectCount = 0;            // 统计：步拒绝次数（诊断用）
function iasSqrt7(a) {             // 机器无关 7 次方根（REBOUND 同款）
  let scale = 1;
  while (a < 1e-7 && a > 0) { scale *= 0.1; a *= 1e7; }
  while (a > 1e2) { scale *= 10; a *= 1e-7; }
  let x = 1;
  for (let k = 0; k < 20; k++) { const x6 = x * x * x * x * x * x; x += (a / x6 - x) / 7; }
  return x * scale;
}
const HIST_MAX = 20000;                                // 轨迹环形缓冲上限（帧）
const LOG_MAX = 10000;                                 // 守恒量日志上限
const LS_KEY = 'nbody_simulation_bodies';              // 与原版兼容
const PREFS_KEY = 'nbody_gr_prefs_v1';
const VIEW_FOV = 66 * Math.PI / 180;                   // 透视与天空盒共用视场角
const SKYBOX_NEAR = 0.05;                              // 天空盒近裁剪面（盒半边长 = 1）
const SKYBOX_GRID = 12;                                // Canvas 2D 回退路径每面细分网格数

/* ---------------- 恒星物理常量 ----------------
 * 恒星阈值取氢燃烧下限约 0.08 M☉；L☉ IAU 2015 标称值，R☉/R⊕/R木 为 IAU 标称半径，T☉=5772 K */
const STAR_M_MIN = 0.08 * M_SUN;
const R_SUN = 6.957e8, R_EARTH_M = 6.371e6, R_JUP_M = 7.1492e7;
const L_SUN = 3.828e26, T_SUN = 5772;
const SIGMA_SB = 5.670374419e-8;                       // 斯特藩-玻尔兹曼常数 W m^-2 K^-4
const F_SUN_1AU = L_SUN / (4 * Math.PI * AU * AU);   // 太阳在 1 AU 处辐照度，约 1361 W/m²



/* ===== 物理核区块 HTML L1379-L1453（原样） ===== */

const TRAIL_FADE_POW = 1.4, TRAIL_ALPHA_LINE = 0.85, TRAIL_ALPHA_DOT = 0.9;
/* ---------------- 全局状态 ---------------- */
let meta = [];            // 每天体: {name,color,size,orbits_around,original_input_params}
let N = 0, CAP = 0;
let px, py, pz, vx, vy, vz, ax, ay, az, massA;       // 状态（Float64Array）
let cpx, cpy, cpz, cvx, cvy, cvz;                     // Kahan 补偿量
let simTime = 0, playing = false;
let scale = 1 / AU * 400;                             // 像素/米，初始 400px = 1 AU
let viewW = 800, viewH = 600, resFactor = 1;
let initialSnapshot = [];                             // 数字化初始状态（重置用）
let initialTotalEnergy = 0, initialTotalMomentum = [0, 0, 0], initialTotalAngular = [0, 0, 0];
let simulationLog = [];
let lastDt = 300, lastSteps = 200;
/* 物理开关
 * v21：GR 默认 1PN→2PN 全开（用户要求）；新增 1.5PN 自旋-轨道/自旋-自旋耦合（Kidder 1995） */
let gr1pnOn = true, gr25On = false, gr2pnOn = true, gr35On = false, gr15spinOn = true, integrator = 'yoshida4';
/* v21 IAS15 工作缓冲（惰性分配，ensureCap 后由 stepIAS15 自查） */
let iasB = null, iasGt = null, iasX0 = null, iasV0 = null, iasA0 = null;
let iasXT = null, iasVT = null, iasAT = null, iasCSx = null, iasCSv = null, iasCap = 0;
let iasSnapB = null, iasSpinT = null, iasSpinZ = null;   // 快照/自旋Radau累加（零GC）
/* v31：Everhart e 预测器与「上接受步提交后真值」副本（REBOUND e/er/br 同构）——
 * 提交后按 ratio 预测下一步 b（含 b−e 修正），拒绝时从副本按新 ratio 重排 */
let iasE = null, iasLastB = null, iasLastE = null;
let iasLastDt = 0, iasDtSuggest = Infinity, iasReady = false, iasN3 = -1;
/* v19 中点阶段试探态缓冲（ensureCap 随主数组扩容）：pm/vm = 中点试探、a/RR/TL = 试探力、
 * pn = 下一次中点、mSpin = 试探自转加速度（真实 spinAcc 在 commit 前不被污染） */
let mpPx = null, mpPy = null, mpPz = null, mpVx = null, mpVy = null, mpVz = null;
let mpAx = null, mpAy = null, mpAz = null;
let mpRX = null, mpRY = null, mpRZ = null, mpTX = null, mpTY = null, mpTZ = null;
let mpPnX = null, mpPnY = null, mpPnZ = null, mpVnX = null, mpVnY = null, mpVnZ = null;
let mpSpin = null;
/* v7 守恒量账本：把潮汐热 / GW 辐射（能量+角动量）与 PN 场动量计入核算，
 * 使开启耗散与高阶项后 ΔE/ΔL/ΔP 恢复物理性（核算后 ≈ 积分器误差级）。
 * Kahan 三元组 [value, comp] 防长程累积舍入。 */
let sinkTideE = [0, 0], sinkGWE = [0, 0];                 // 潮汐累计热 / GW 辐射能（J，正值=流失）
let sinkGWLx = [0, 0], sinkGWLv = [0, 0], sinkGWLz = [0, 0]; // GW 辐射角动量（kg·m²/s）
let fieldPx = [0, 0], fieldPv = [0, 0], fieldPz = [0, 0];   // PN 场动量（EIH a_B 牛顿代入的残余）
let axRR, ayRR, azRR;                                     // 辐射反作用分加速度（2.5+3.5PN，账本用）
let axTL, ayTL, azTL;                                     // 潮汐滞后分加速度（账本用）
/* 潮汐相互作用（动力学）：平衡潮 CTL 模型，力作用于轨道 + 自转力矩演化。
 * 缺省开启：k2 自动 0.3，时滞缺省 0（纯保守潮，能量严格守恒）；
 * 仅当天体设置 tide_lag > 0 时产生耗散（轨道圆化/收缩、自转同步）。 */
let tideOn = true;
/* v35：J2 扁率摄动独立开关（保守进动/章动；不再依附潮汐耗散总开关）。
 * v35 关键修复：v34 及以前的 J2 力/力矩/势能符号全部相反（等效负 J2）——
 * 经「薄环精确级数 + 均匀扁椭球 GL 求积」双重数值裁决确认（见 worklog 35-1），
 * 本版全部翻转为标准方向（Vallado 8-57 / Murray & Dermott）：
 *   a_j = +K[(5c²-1)n̂ - 2cŝ]，N_i = -3GmmJ2R²(ŝ·n̂)(ŝ×n̂)/r³，U_J2 = +GmmJ2R²P2(c)/r³ */
let j2On = true;
/* v35：强场 PW 伪牛顿势（Paczyński–Wiita 1980）——强场模式开关。
 * 成对替换牛顿项：a = ∓Gm/(r-r_g)²n̂，r_g = 2G(m_i+m_j)/c²（成对 Schwarzschild 半径和
 * = 两黑洞视界和；成对对称→动量守恒）。
 * 精确再现 Schwarzschild ISCO（3r_g = 6GM/c²）、边缘束缚圆轨（2r_g = 4GM/c²）；
 * 近心点进动 ≈ 4πGM/(c²a(1-e²))（PW 已知特性：偏高阶项，约 GR 的 2/3）。
 * 开启 PW 时不应叠加 1PN（UI 有提示）。 */
let pwOn = false;
let tideHeatW = 0;                     // 潮汐耗散功率瞬时值（UI 读数，W）
let spinRate, spinAcc;                 // 自转角速度 rad/s 与 dΩ/dt（潮汐力矩/转动惯量）
let spinTx, spinTy, spinTz;            // v19e 自转力矩向量 N⃗（N·m）：垂直分量进动自转轴，平行分量改 |Ω|
let spinPhase, cspinPhase;             // 自转相位积分 φ=∫Ωdt（Kahan 补偿）——Ω 随潮汐演化时渲染相位仍准确
let bodyRadA, bodyK2A, bodyLagA, bodyIA, bodyTideA0;  // 每天体潮汐缓存（R, k2, Δt, I, k2·G·R⁵）
let bodyTideA03;                                       // v19e 八极潮缓存 k3·G·R⁷（k3=k2/3，不对称高阶潮）
let bodyK2Auto, bodyLagAuto;                           // 该天体 k2/Δt 是否为自动模式（留空）
let spinAxX, spinAxY, spinAxZ;         // 自转轴单位向量（渲染与潮汐力矩共用；v19e 起随潮汐力矩演化）
/* 渲染开关与相机状态 */
let projMode = 'persp';                // ortho 正交 / persp 透视（v5 起默认透视）
let physSizeOn = true;                 // 星球真实尺寸（v22 默认开，用户要求；老存档仍按存档恢复）
/* v30：叠层透镜模式选择栏退役（用户裁决：非光线追踪的屏幕空间后处理无法
 * 准确弯曲「近处/背后/围绕一圈」的叠层 —— 屏幕缓冲里被影子/视野边界裁掉的
 * 像素信息先天缺失，无法凭空重建弯曲像；光子环内多级像更不可能。因此
 * 「物体式」整体退役，叠层恒走「绝对」路径（v20/v24/v28b LDR 叠加层语义，
 * v28 四修复与遮挡系统全部保留），occlMode 变量与选择栏一并删除。 */
let starRadOn = true;                  // 恒星黑体辐射照明
let glareOn = true;                    // 亮度眩光与发白
let headlessOn = false;                // 无头模式
let camOff = [0, 0, 0];                // 自由视角平移偏移（世界系，不参与物理）
let skyMode = 'none';                  // webgl / canvas2d / none
let skyApplyHook = null;               // v7：外部全景图注入钩子（材质库用），skyboxLoad 内赋值
/* 轨迹环形缓冲 */
const histT = new Float64Array(HIST_MAX);
const histPos = new Array(HIST_MAX);
const histVel = new Array(HIST_MAX);   /* v36：速度快照（轨迹开普勒预测弧用；仅渲染读取） */
let histHead = 0, histCount = 0;
/* 进动采样 */
let grSamples = [];
/* 引力波波形（四极公式，h+/h× 环形缓冲） */
let gwWaveOn = false, gwSamples = [], gwLast = null;
/* 加速度统计（自适应步长用） */
let minR2 = Infinity, maxAccMag = 0, minPairM = 0, minPairV2 = 0;   // minPairV2：最近对相对速度²（位移判据用）


/* ===== 物理核区块 HTML L1461-L1473（原样） ===== */

/* ---------------- 工具 ---------------- */
function kahanAdd(arr, comp, i, delta) {
  const y = delta - comp[i];
  const t = arr[i] + y;
  comp[i] = (t - arr[i]) - y;
  arr[i] = t;
}
function wrapPi(x) { return (x + Math.PI) % (2 * Math.PI) + (x + Math.PI < 0 ? Math.PI : -Math.PI); }
function clampNum(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function smoothStepN(e0, e1, x) {
  const t = clampNum((x - e0) / (e1 - e0 || 1e-30), 0, 1);
  return t * t * (3 - 2 * t);
}


/* ===== 物理核区块 HTML L1541-L1695（原样） ===== */


/* ---------------- v7 结构参数合一：洛夫数 k2 / 潮汐时滞 Δt / 流体系数经验公式 ----------------
 * 用户只填一个可选的 k2；留空时按质量+半径自动推算（本函数）。
 * 公式分段锚定实测值：
 *   黑洞   C=GM/(Rc²)≥0.45      → k2 = 0（Binnington-Poisson 2009：BH 潮汐洛夫数为零）
 *   中子星 C>0.05               → k2 = 0.195(1−2C)²，canonical 1.4M☉/12km → 0.084
 *                                  （Λ=(2/3)k2/C⁵ ≈ 373，GW170817 量级 Λ~300-800）
 *   主序星 M≥0.08M☉            → k2 = 0.056(M/M☉)^−0.65，太阳锚定 0.056
 *                                  （全对流 M<0.35M☉ 偏高至 ~0.11，n=3 辐射星偏低至 ~0.012）
 *   棕矮星 M≥13M_J              → 0.3·(M/40M_J)^−0.1
 *   气巨   M≥50M⊕               → 0.49+0.44·log10(ρ̄/1326)，木星 0.49 / 土星 0.36 锚定
 *   冰巨   M≥10M⊕               → 0.11（天王 0.104 / 海王 0.117 实测）
 *   岩质   ρ̄≥2500, M≥0.05M⊕   → 0.30+0.163·log10(M/M⊕)：地球 0.298、火星 0.142（实测0.14）
 *   岩质   M<0.05M⊕            → 0.0242·(M/0.0123M⊕)^0.4（月球 0.0242 锚定，小冷天体偏刚）
 *   冰卫星 其余                 → 大 0.20 / 小冷 0.04（土卫六~0.5、木卫三~0.31 差异大，取中值）
 * 已知偏差个案（仅凭 M、R 不可辨识，文档已声明）：水星热核 0.45、木卫一潮汐加热 ~0.3 */
function autoK2(mass, R) {
  if (!(mass > 0) || !(R > 0)) return TIDE_K2_DEFAULT;
  if (isBlackHolePhys(mass, R)) return 0;   /* v21：视界无潮汐隆起 */
  const C = G * mass / (R * C_SQ);
  if (C > 0.05) return clampNum(0.195 * Math.pow(1 - 2 * C, 2), 0.02, 0.19);
  if (mass >= STAR_M_MIN) return clampNum(0.056 * Math.pow(mass / M_SUN, -0.65), 0.01, 0.15);
  if (mass >= 13 * M_JUPITER) return clampNum(0.3 * Math.pow(mass / (40 * M_JUPITER), -0.1), 0.15, 0.4);
  const me = mass / M_EARTH;
  const rho = mass / (4 / 3 * Math.PI * R * R * R);
  if (me >= 50) return clampNum(0.49 + 0.44 * Math.log10(rho / 1326), 0.15, 0.55);
  if (me >= 10) return 0.11;
  if (rho >= 2500) {
    if (me >= 0.05) return clampNum(0.30 + 0.163 * Math.log10(me), 0.015, 0.55);   /* 地球 0.298 / 火星 0.142 */
    return clampNum(0.0242 * Math.pow(me / 0.0123, 0.4), 0.008, 0.08);             /* 月球 0.0242 锚定 */
  }
  return me >= 0.001 ? 0.20 : 0.04;
}
/* 潮汐时滞 Δt 自动值：Δt = 1/(Q·n(10R))；类地直接取地球海潮有效值 600 s 锚点。
 * 潮汐锁定天体（Ω=n）该项自然不激活（滞后向量 l⃗=0），不影响已锁定卫星。 */
function autoTideLag(mass, R) {
  if (!(mass > 0) || !(R > 0)) return 0;
  if (isBlackHolePhys(mass, R)) return 0;   /* v21：视界无潮汐耗散 */
  const C = G * mass / (R * C_SQ);
  if (C > 0.05) return 1 / (TIDE_Q_NS * Math.sqrt(G * mass / Math.pow(10 * R, 3)));
  if (mass >= STAR_M_MIN) return 1 / (TIDE_Q_STAR * Math.sqrt(G * mass / Math.pow(10 * R, 3)));
  if (mass >= 13 * M_JUPITER) return 1 / (TIDE_Q_BD * Math.sqrt(G * mass / Math.pow(10 * R, 3)));
  const me = mass / M_EARTH;
  const rho = mass / (4 / 3 * Math.PI * R * R * R);
  if (me >= 10) return 1 / (TIDE_Q_GIANT * Math.sqrt(G * mass / Math.pow(10 * R, 3)));
  if (rho >= 2500) return 600;
  return 1e4;
}
/* ---------------- 恒星天体物理（渲染用，不影响引力计算） ----------------
 * massRadius: 质量半径经验关系，米。
 * v30 行星段锚点补真实水星/火星（旧表 [0.05,0.40]/[0.3,0.72] 间插值给水星
 * +8% 半径/-20% 密度、火星 -3.5%/+11%）；恒星段废弃单一幂律（旧 x^0.8/x^0.57
 * 在 0.5M☉ +24%、20M☉ -41%，密度误差近 3 倍），改主序锚点对数插值
 * （Eker 2018 / Torres 2010 / Cox 2000 主序中值）+ >40M☉ 幂律延伸。
 * 行星段锚点取 IAU 平均半径口径：水星 0.383 / 海王星 3.86 / 天王星 3.98 /
 * 土星 9.14 / 木星 10.97 R⊕，岩石行星趋势参照 Zeng et al. 2016。
 * 小于 0.05 M⊕ 按常密度 3300 kg/m³ 球体反解。 */
const MR_ANCHORS = [[0.05, 0.38], [0.0553, 0.3833], [0.10745, 0.5320], [0.3, 0.72], [1, 1.0], [2, 1.30], [5, 2.0], [14.5, 3.98], [17.1, 3.86], [95, 9.14], [318, 10.97], [1300, 11.6], [4131, 10.3]];
/* 主序恒星段锚点（x=M/M☉ → R/R☉）：Eker+2018 / Torres+2010 主序中值，
 * 锚点处半径误差 ≲5%（观测弥散内）；>40 M☉ 幂律 R = 16·(x/40)^0.7 延伸 */
const STAR_MR_ANCHORS = [[0.08, 0.118], [0.1, 0.13], [0.15, 0.18], [0.2, 0.23], [0.3, 0.32], [0.4, 0.40], [0.5, 0.46], [0.6, 0.55], [0.7, 0.65], [0.8, 0.75], [0.9, 0.87], [1, 1.0], [1.15, 1.10], [1.3, 1.30], [1.5, 1.48], [1.75, 1.66], [2, 1.85], [2.5, 2.25], [3, 2.62], [4, 3.30], [5, 3.95], [7, 5.10], [10, 6.20], [15, 8.30], [20, 10.0], [30, 13.0], [40, 16.0]];
function massRadius(m) {
  /* v20 边界保护（自动设置物理合理性检查）：非有限/非正 → 0；结果钳到 [0.1 m, 1e13 m]，
   * 防极端质量输入外推至 Inf/0 导致潮汐缓存 NaN、自适应步长崩溃 */
  const r = massRadiusRaw(m);
  return isFinite(r) ? clampNum(r, 0.1, 1e13) : 0;
}
function massRadiusRaw(m) {
  if (!(m > 0) || !isFinite(m)) return 0;
  m = Math.min(m, 1e45);
  if (m >= STAR_M_MIN) {
    /* v30：主序锚点对数插值（旧幂律 0.5M☉ +24% / 20M☉ -41% 已废） */
    const x = m / M_SUN;
    const A = STAR_MR_ANCHORS;
    if (x >= A[A.length - 1][0]) return R_SUN * A[A.length - 1][1] * Math.pow(x / A[A.length - 1][0], 0.7);
    for (let k = 0; k < A.length - 1; k++) {
      if (x <= A[k + 1][0]) {
        const t = (Math.log(x) - Math.log(A[k][0])) / (Math.log(A[k + 1][0]) - Math.log(A[k][0]));
        return R_SUN * Math.exp(Math.log(A[k][1]) + t * (Math.log(A[k + 1][1]) - Math.log(A[k][1])));
      }
    }
    return R_SUN;
  }
  if (m >= 13 * M_JUPITER) return R_JUP_M * Math.pow(m / (13 * M_JUPITER), -0.09);
  const me = m / M_EARTH;
  if (me < 0.05) return Math.cbrt(3 * m / (4 * Math.PI * 3300));
  const A = MR_ANCHORS;
  if (me >= A[A.length - 1][0]) return A[A.length - 1][1] * R_EARTH_M;
  for (let k = 0; k < A.length - 1; k++) {
    if (me <= A[k + 1][0]) {
      const t = (Math.log(me) - Math.log(A[k][0])) / (Math.log(A[k + 1][0]) - Math.log(A[k][0]));
      return R_EARTH_M * Math.exp(Math.log(A[k][1]) + t * (Math.log(A[k + 1][1]) - Math.log(A[k][1])));
    }
  }
  return R_EARTH_M;
}
/* 分段质光关系（Kippenhahn & Weigert 恒星结构标准近似），返回瓦特 */
function starLuminosity(m) {
  const x = m / M_SUN;
  if (x < 0.43) return L_SUN * 0.23 * Math.pow(x, 2.3);
  if (x < 2) return L_SUN * Math.pow(x, 4);
  if (x <= 20) return L_SUN * 1.5 * Math.pow(x, 3.5);
  return L_SUN * 3000 * x;
}
/* 有效温度：质量 + 平均密度共同决定（黑体谱不单看质量）。
 * 主序基准 T_ms = 质光关系 L(m) 在主序半径 R_ms 处按 L=4πR²σT⁴ 反解；
 * 实际半径偏离主序时，平均密度 ρ = 3m/(4πr³) 随之偏离 ρ_ms，按同调关系
 * T ∝ (ρ/ρ_ms)^(1/24) 缓变（指数弱，质量不大而半径很大时温度确实下降，
 * 但不像 1/√r 那样把巨星压到 500 K 的非物理低温）；
 * 膨胀进入巨星支时以 Hayashi 下限托底（Hayashi 1961：红巨星/红超巨有效温度
 * 不能低于 Hayashi 线，观测值 3200~4500 K，随质量微增）。
 * 亮度由调用方按 L = 4πR²σT⁴ 用新温度与真实表面积计算 —— 巨星因面积
 * 增大而真实变亮（1 M☉ + 100 R☉ → T≈3600 K，L≈1500 L☉，与观测红巨星同量级）。 */
const HAYASHI_T0 = 3500, HAYASHI_M_EXP = 0.08, RHO_T_EXP = 1 / 24;
function starTemperature(m, r) {
  if (!(r > 0)) r = massRadius(m);
  const Rms = massRadius(m);
  const Tms = T_SUN * Math.pow(starLuminosity(m) / L_SUN, 0.25) * Math.sqrt(R_SUN / Rms);
  const Tdens = Tms * Math.pow(Math.pow(Rms / r, 3), RHO_T_EXP);
  if (r <= Rms) return Tdens;
  return Math.max(Tdens, HAYASHI_T0 * Math.pow(m / M_SUN, HAYASHI_M_EXP));
}
/* ---------------- 恒星物理缓存（亮度一次计算，处处复用） ----------------
 * 按用户要求：根据恒星温度和表面积计算一次亮度，然后再具体计算。
 * 链条：质量 → 半径 R（质径关系或用户指定）→ 有效温度 T（质光关系 + 密度同调修正 + Hayashi 下限）
 *       → 亮度 L = 4πR²σT⁴（温度×表面积真实计算，一次缓存；巨星因面积而变亮）
 *       → 表面辐射亮度 B = L/(4π²R²) = σT⁴/π（单位 F_SUN_1AU/sr，距离无关，面元亮度守恒）
 * 之后辐照度（PSF 点源、行星照明、计量、眩光）与圆面渲染全部取自缓存。
 * Python 数值校验：太阳 L 偏差 0.000%、B=14719、B·πθ² = L/(4πd²) 全距离闭环、
 * PSF↔圆面切换比恰为 1.00；红巨星支（1 M☉/100 R☉）T≈3600 K、L≈1.5e3 L☉。 */
let starPhysCache = [];   // 每天体索引 → {R, T, L, B, rgb, rgbLin} 或 null（非恒星）
/* v21：黑洞物理判定（更物理，用户要求）。R ≤ r_s = 2GM/c²（事件视界内/上）→ 黑洞；
 * radius 未填（0/负/NaN）= 「自动半径」——代入 massRadius(mass) 质量半径经验关系
 * （与潮汐缓存/渲染管线同一口径），再用推算半径比较 r_s。因此 10 M☉ 未填半径 →
 * 主序星推算 2.3 R☉ ≫ r_s → 正常恒星（v22 预验证 B 组：此前 TOV 质量阈值启发是
 * 画蛇添足，会把未填半径的大质量恒星误判成黑洞——已删）。显式给极小半径
 * （R ≤ r_s）才判黑洞。isBlackHolePhys 为渲染/透镜/潮汐/形变的唯一判据。 */
function schwarzschildRadius(mass) { return 2 * G * mass / C_SQ; }
/* v22：Kerr 视界周期 → 自旋参数 a*（用户自转周期的黑洞语义 = 视界角速度周期）：
 * Ω_H = a c³/(2GM(1+√(1−a²)))，T=2π/Ω_H → k = c³T/(4πGM) → a* = 2k/(k²+1)
 * （a*=1 ↔ k=1 ↔ T_min=4πGM/c³；k<1 超极限 → 0.999；T≤0/ω=0 → 0）。
 * Python 预验证 K1–K5：往返一致 5 a*×2 质量、20M☉+0.01s → 0.2439、T_min=1.24ms。 */
function kerrAStarFromPeriod(T_sec, mass) {
  if (!(T_sec > 0)) return 0;
  const k = T_sec / (4 * Math.PI * (G * mass / (C_SQ * C_LIGHT)));
  if (k < 1) return 0.999;
  return Math.min(0.999, 2 * k / (k * k + 1));
}
function isBlackHolePhys(mass, radius) {
  if (!(mass > 0)) return false;
  const rs = 2 * G * mass / C_SQ;
  let R = radius;
  if (!(R > 0)) R = massRadius(mass);   /* 未填半径 = 自动推算（潮汐/渲染同口径） */
  return R > 0 && R <= rs;
}


/* ===== 物理核区块 HTML L2410-L2455（原样） ===== */

/* ---------------- 状态数组管理 ---------------- */
function ensureCap(n) {
if (globalThis.__ENGINE__ && __ENGINE__.active) return __ENGINE__.growCap(n);   /* v34: WASM 内存接管（激活时） */
  if (n <= CAP) return;
  const newCap = Math.max(n, CAP ? CAP * 2 : 64);
  const grow = (arr) => { const a = new Float64Array(newCap); if (arr) a.set(arr.subarray(0, CAP)); return a; };
  px = grow(px); py = grow(py); pz = grow(pz);
  vx = grow(vx); vy = grow(vy); vz = grow(vz);
  ax = grow(ax); ay = grow(ay); az = grow(az);
  massA = grow(massA);
  cpx = grow(cpx); cpy = grow(cpy); cpz = grow(cpz);
  cvx = grow(cvx); cvy = grow(cvy); cvz = grow(cvz);
  spinRate = grow(spinRate); spinAcc = grow(spinAcc);
  spinTx = grow(spinTx); spinTy = grow(spinTy); spinTz = grow(spinTz);
  spinPhase = grow(spinPhase); cspinPhase = grow(cspinPhase);
  bodyRadA = grow(bodyRadA); bodyK2A = grow(bodyK2A); bodyLagA = grow(bodyLagA);
  bodyIA = grow(bodyIA); bodyTideA0 = grow(bodyTideA0); bodyTideA03 = grow(bodyTideA03);
  bodyK2Auto = grow(bodyK2Auto); bodyLagAuto = grow(bodyLagAuto);
  spinAxX = grow(spinAxX); spinAxY = grow(spinAxY); spinAxZ = grow(spinAxZ);
  axRR = grow(axRR); ayRR = grow(ayRR); azRR = grow(azRR);
  axTL = grow(axTL); ayTL = grow(ayTL); azTL = grow(azTL);
  mpPx = grow(mpPx); mpPy = grow(mpPy); mpPz = grow(mpPz);
  mpVx = grow(mpVx); mpVy = grow(mpVy); mpVz = grow(mpVz);
  mpAx = grow(mpAx); mpAy = grow(mpAy); mpAz = grow(mpAz);
  mpRX = grow(mpRX); mpRY = grow(mpRY); mpRZ = grow(mpRZ);
  mpTX = grow(mpTX); mpTY = grow(mpTY); mpTZ = grow(mpTZ);
  mpPnX = grow(mpPnX); mpPnY = grow(mpPnY); mpPnZ = grow(mpPnZ);
  mpVnX = grow(mpVnX); mpVnY = grow(mpVnY); mpVnZ = grow(mpVnZ);
  mpSpin = grow(mpSpin);
  bufVer++;                              // v19f：包装数组缓存失效
  CAP = newCap;
}
function zeroKahan() {
  cpx && cpx.fill(0); cpy && cpy.fill(0); cpz && cpz.fill(0);
  cvx && cvx.fill(0); cvy && cvy.fill(0); cvz && cvz.fill(0);
}
/* v7 账本清零（initState / 重置用）*/
function resetLedger() {
  sinkTideE[0] = 0; sinkTideE[1] = 0;
  sinkGWE[0] = 0; sinkGWE[1] = 0;
  sinkGWLx[0] = 0; sinkGWLx[1] = 0;
  sinkGWLv[0] = 0; sinkGWLv[1] = 0;
  sinkGWLz[0] = 0; sinkGWLz[1] = 0;
  fieldPx[0] = 0; fieldPx[1] = 0;
  fieldPv[0] = 0; fieldPv[1] = 0;
  fieldPz[0] = 0; fieldPz[1] = 0;
}


/* ===== 物理核区块 HTML L2457-L2854（原样） ===== */

/* ---------------- 加速度（牛顿 + EIH 完整 N 体 1PN + 2PN 保守 + 2.5PN/3.5PN 辐射反应 + 潮汐） ----------------
 * v7 升级（公式源已逐项数值/符号验证）：
 *   1PN：成对修正（调和规范两体相对式，两文献来源互证 + 水星 42.98″/世纪实测验证）。
 *        跨体交叉项（Will PRL 2018）列入 v8 路线图（见下方代码内说明）。
 *   2PN：两体保守加速度（IW95 eq. a2PN = Blanchet LR calA₂/calB₂，两来源已逐项互证），
 *        (m_j/M, m_i/M) 加权分配 → 动量严格守恒；需 1PN 开启。
 *   2.5PN：Iyer-Will 瞬时辐射反作用（v6 已验证：圆轨道衰减 vs Peters 0.00%）。
 *   3.5PN：瞬时辐射反作用（Blanchet LR calA₃.₅/calB₃.₅ 转录）——实验性（默认关）。
 *   潮汐（平衡潮 CTL，Mignard/Hut 1981）：同 v6——保守潮 −6k₂Gm′²R⁵/r⁷·r̂ +
 *        时滞耗散 (3k₂Gm′²R⁵Δt/r⁷)(Ω⃗×r̂ − v⃗ₜ/r)，自转力矩 N = −r⃗×f_lag·ŝ，Ω̇ = N/I。
 * 账本：辐射反作用（2.5+3.5PN）与潮汐滞后分加速度分别存入 axRR/axTL，
 *   kick() 内累积 GW 辐射能/角动量与潮汐热，使 ΔE/ΔL 核算后恢复物理性。 */
/* v19：加速度求值参数化 —— 可在任意试探态 (P,V) 求力（隐式中点迭代用）。
 * computeAccel() 语义不变 = 真实态求值。minR2/maxAccMag/minPairM/tideHeatW 仍为全局
 * 统计（试探求值会改写，调用方 stageMidpoint 负责快照/恢复）。 */
function computeAccel() {
  /* v19f：包装数组按缓冲版本缓存（ensureCap 重分配后失效），消除每次调用的 5 个数组分配 */
  if (_wrapVer !== bufVer) {
    _wP[0] = px; _wP[1] = py; _wP[2] = pz;
    _wV[0] = vx; _wV[1] = vy; _wV[2] = vz;
    _wA[0] = ax; _wA[1] = ay; _wA[2] = az;
    _wRR[0] = axRR; _wRR[1] = ayRR; _wRR[2] = azRR;
    _wTL[0] = axTL; _wTL[1] = ayTL; _wTL[2] = azTL;
    _wrapVer = bufVer;
  }
  accumulateAccel(_wP, _wV, _wA,
    axRR ? _wRR : null,
    axTL ? _wTL : null,
    spinAcc);
}
let _wrapVer = -1, bufVer = 0;
const _wP = [null, null, null], _wV = [null, null, null], _wA = [null, null, null];
const _wRR = [null, null, null], _wTL = [null, null, null];
let _mpWrapVer = -1;
const _wMP = [null, null, null], _wMV = [null, null, null], _wMA = [null, null, null];
const _wMR = [null, null, null], _wMT = [null, null, null];
function accumulateAccel(P, V, A, RR, TL, SA) {
if (globalThis.__ENGINE__ && __ENGINE__.active && P === _wP && V === _wV && A === _wA) return __ENGINE__.accumDispatch();   /* v34: WASM 内核派发（真实态求值） */
  const px = P[0], py = P[1], pz = P[2];
  const vx = V[0], vy = V[1], vz = V[2];
  const ax = A[0], ay = A[1], az = A[2];
  const axRR = RR ? RR[0] : null, ayRR = RR ? RR[1] : null, azRR = RR ? RR[2] : null;
  const axTL = TL ? TL[0] : null, ayTL = TL ? TL[1] : null, azTL = TL ? TL[2] : null;
  const spinAcc = SA;
  minR2 = Infinity; maxAccMag = 0; minPairM = 0; minPairV2 = 0;
  tideHeatW = 0;
  /* v19f：缓冲无消费者时不清零（读方均在 tideOn/gr15spin 分支内）；v21 起自旋进动也写 spinT */
  if ((tideOn || gr15spinOn || j2On) && spinAcc) spinAcc.fill(0, 0, N);
  if ((tideOn || gr15spinOn || j2On) && spinTx) { spinTx.fill(0, 0, N); spinTy.fill(0, 0, N); spinTz.fill(0, 0, N); }
  const soft = GRAV_SOFTENING_SQ;
  const pnMin2 = PN_TIDE_R_MIN * PN_TIDE_R_MIN;
  for (let i = 0; i < N; i++) { ax[i] = 0; ay[i] = 0; az[i] = 0; }
  if (axRR) {
    axRR.fill(0, 0, N); ayRR.fill(0, 0, N); azRR.fill(0, 0, N);
    axTL.fill(0, 0, N); ayTL.fill(0, 0, N); azTL.fill(0, 0, N);
  }
  for (let i = 0; i < N; i++) {
    const xi = px[i], yi = py[i], zi = pz[i], mi = massA[i];
    const Gmi = G * mi;
    const A0i = tideOn ? bodyTideA0[i] : 0;
    const RI = tideOn ? bodyRadA[i] : 0, lagI = tideOn ? bodyLagA[i] : 0;
    const six = spinAxX[i], siy = spinAxY[i], siz = spinAxZ[i];
    const omI = spinRate[i];
    let axi = 0, ayi = 0, azi = 0;
    for (let j = i + 1; j < N; j++) {
      const dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi;
      const r2raw = dx * dx + dy * dy + dz * dz;
      const dvx = vx[j] - vx[i], dvy = vy[j] - vy[i], dvz = vz[j] - vz[i];
      if (r2raw < minR2) { minR2 = r2raw; minPairM = mi + massA[j]; minPairV2 = dvx * dvx + dvy * dvy + dvz * dvz; }
      const invR = 1 / Math.sqrt(r2raw);
      const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
      const r2 = r2raw + soft, rS = Math.sqrt(r2), invR3v = 1 / (r2 * rS);
      let fj = G * massA[j] * invR3v, fi = Gmi * invR3v;
      if (pwOn) {
        /* v35：强场 PW 伪牛顿势（成对对称，动量守恒）。r_g = 2G(m_i+m_j)/c² =
         * 成对 Schwarzschild 半径和（= 两视界和 → 并合接触距离恰为奇异点）。
         * denom 下限 0.05r_g 防奇异（开启并合时接触半径 = r_g 先于该域触发并合）。 */
        const rgPW = 2 * G * (mi + massA[j]) / C_SQ;
        const dPW = Math.sqrt(r2raw + soft);
        const denPW = Math.max(dPW - rgPW, 0.05 * rgPW);
        const gPW = 1 / (denPW * denPW * dPW);   // ×dPW 使 fj·d⃗ = G mj/den² · n̂（fj = G mj·gPW）
        fj = G * massA[j] * gPW;
        fi = Gmi * gPW;
      }
      axi += fj * dx; ayi += fj * dy; azi += fj * dz;
      ax[j] -= fi * dx; ay[j] -= fi * dy; az[j] -= fi * dz;
      if ((gr2pnOn || gr25On) && r2raw > pnMin2) {
        const mj = massA[j], M = mi + mj;
        const nx = dx * invR, ny = dy * invR, nz = dz * invR;
        const rd = dvx * nx + dvy * ny + dvz * nz;
        const eta = (mi * mj) / (M * M);
        const GMr = G * M * invR;
        const wi = -mj / M, wj = mi / M;
        if (gr2pnOn) {
          /* ---- 2PN 保守（IW95 a2PN = Blanchet calA₂/calB₂，调和规范，已互证）----
           * a = −GM/r²{ n[A₂] − (1/2)ṙ v[B₂] }，O(c⁻⁴) */
          const A2 = (0.75 * (12 + 29 * eta) * GMr * GMr
            + eta * (3 - 4 * eta) * v2 * v2
            + 1.875 * eta * (1 - 3 * eta) * rd * rd * rd * rd
            - 1.5 * eta * (3 - 4 * eta) * v2 * rd * rd
            - 0.5 * eta * (13 - 4 * eta) * GMr * v2
            - (2 + 25 * eta + 2 * eta * eta) * GMr * rd * rd) / (C_SQ * C_SQ);
          const B2 = -0.5 * rd * (eta * (15 + 4 * eta) * v2
            - (4 + 41 * eta + 8 * eta * eta) * GMr
            - 3 * eta * (3 + 2 * eta) * rd * rd) / (C_SQ * C_SQ);
          const kk = -G * M * invR * invR;   /* −GM/r²（Python 验证版一致，勿用 invR/r2raw = 1/r³） */
          const arx = kk * (A2 * nx + B2 * dvx);
          const ary = kk * (A2 * ny + B2 * dvy);
          const arz = kk * (A2 * nz + B2 * dvz);
          axi += wi * arx; ayi += wi * ary; azi += wi * arz;
          ax[j] += wj * arx; ay[j] += wj * ary; az[j] += wj * arz;
        }
        if (gr25On) {
          /* ---- 2.5PN 瞬时辐射反作用（Iyer-Will，v6 验证 vs Peters 0.00%）---- */
          const k25 = 1.6 * eta * (G * G * M * M) / (C_5 * r2raw * Math.sqrt(r2raw));
          const ar = k25 * rd * (3 * v2 + (17 / 3) * GMr);
          const av = k25 * (v2 + 3 * GMr);
          const a25x = nx * ar - dvx * av, a25y = ny * ar - dvy * av, a25z = nz * ar - dvz * av;
          axi += wi * a25x; ayi += wi * a25y; azi += wi * a25z;
          ax[j] += wj * a25x; ay[j] += wj * a25y; az[j] += wj * a25z;
          if (axRR) {
            axRR[i] += wi * a25x; ayRR[i] += wi * a25y; azRR[i] += wi * a25z;
            axRR[j] += wj * a25x; ayRR[j] += wj * a25y; azRR[j] += wj * a25z;
          }
          if (gr35On) {
            /* ---- 3.5PN 瞬时辐射反作用（Blanchet LR calA₃.₅/calB₃.₅）——实验性 ---- */
            const C7 = C_5 * C_SQ;
            const A35 = (GMr * eta / r2raw) * rd * ((GMr * GMr) * (3956 / 35 + 184 * eta / 5)
              + (GMr * v2) * (692 / 35 - 724 * eta / 15)
              + v2 * v2 * (366 / 35 + 12 * eta)
              + (GMr * rd * rd) * (294 / 5 + 376 * eta / 5)
              - v2 * rd * rd * (114 + 12 * eta) + 112 * rd * rd * rd * rd) / C7;
            const B35 = (GMr * eta / r2raw) * ((GMr * GMr) * (-1060 / 21 - 104 * eta / 5)
              + (GMr * v2) * (164 / 21 + 148 * eta / 5)
              + v2 * v2 * (-626 / 35 - 12 * eta / 5)
              + (GMr * rd * rd) * (-82 / 3 - 848 * eta / 15)
              + v2 * rd * rd * (678 / 5 + 12 * eta / 5) - 120 * rd * rd * rd * rd) / C7;
            const kk3 = -G * M * invR * invR;  /* 同上 −GM/r² */
            const a35x = kk3 * (A35 * nx + B35 * dvx);
            const a35y = kk3 * (A35 * ny + B35 * dvy);
            const a35z = kk3 * (A35 * nz + B35 * dvz);
            axi += wi * a35x; ayi += wi * a35y; azi += wi * a35z;
            ax[j] += wj * a35x; ay[j] += wj * a35y; az[j] += wj * a35z;
            if (axRR) {
              axRR[i] += wi * a35x; ayRR[i] += wi * a35y; azRR[i] += wi * a35z;
              axRR[j] += wj * a35x; ayRR[j] += wj * a35y; azRR[j] += wj * a35z;
            }
          }
        }
      }
      if (gr15spinOn && r2raw > pnMin2) {
        /* ---- v21 1.5PN 自旋-轨道 + 2PN 自旋-自旋（Kidder 1995, PRD 52, 821,
         *      eq. 2.2c/2.2e/2.4；原文页图逐式核对，Python 验证
         *      scripts/v21_physics_test.py B：轨道平均扭矩 vs Kidder 4.17a
         *      七位数吻合、SO+SS 能量守恒 3.5e-13、de Sitter/LT 极限通过）----
         * 约定：x' = x_j−x_i（与 1PN 块同），arel 为相对加速度 →
         *   a_i = −(m_j/M)·arel, a_j = +(m_i/M)·arel → 动量严格守恒。
         *   a_SO = G/(c²r³){ 6n̂[(n̂×v)·(2S+δm/m·Δ)] − [v×(7S+3δm/m·Δ)]
         *                    + 3ṙ[n̂×(3S+δm/m·Δ)] }，
         *   S = S_i+S_j，Δ = m(S_j/m_j − S_i/m_i)，δm = m_i−m_j；
         *   a_SS = 3G/(c²μr⁴){ −n̂(S_i·S_j) + S_i(n̂·S_j) + S_j(n̂·S_i)
         *                      − 5n̂(n̂·S_i)(n̂·S_j) }。
         *   S⃗ = I·Ω·ŝ（I = TIDE_GYRATION·m·R²，refreshBodyTideCache 缓存）。
         *   注意 2.2c 在 (n̂,v)→(−n̂,−v) 下逐项不变（叉积偶性），与 Kidder 的
         *   x₁−x₂ 约定结果一致。两项均保守（能量账本配套 H_SO/H_SS，
         *   见 computeTotalEnergy）。 */
        const mj = massA[j], M = mi + mj;
        const nx = dx * invR, ny = dy * invR, nz = dz * invR;
        const rd15 = dvx * nx + dvy * ny + dvz * nz;
        const sjx = spinAxX[j], sjy = spinAxY[j], sjz = spinAxZ[j];
        const omJ = spinRate[j];
        const SIx = bodyIA[i] * omI * six, SIy = bodyIA[i] * omI * siy, SIz = bodyIA[i] * omI * siz;
        const SJx = bodyIA[j] * omJ * sjx, SJy = bodyIA[j] * omJ * sjy, SJz = bodyIA[j] * omJ * sjz;
        const dmm = (mi - mj) / M;   /* δm/m（Kidder 2.2c 的 Δ 系数） */
        const Sx = SIx + SJx, Sy = SIy + SJy, Sz = SIz + SJz;
        const Dlx = M * (SJx / mj - SIx / mi), Dly = M * (SJy / mj - SIy / mi), Dlz = M * (SJz / mj - SIz / mi);
        const A2x = 2 * Sx + dmm * Dlx, A2y = 2 * Sy + dmm * Dly, A2z = 2 * Sz + dmm * Dlz;
        const A7x = 7 * Sx + 3 * dmm * Dlx, A7y = 7 * Sy + 3 * dmm * Dly, A7z = 7 * Sz + 3 * dmm * Dlz;
        const A3x = 3 * Sx + dmm * Dlx, A3y = 3 * Sy + dmm * Dly, A3z = 3 * Sz + dmm * Dlz;
        const cxv = ny * dvz - nz * dvy, cyv = nz * dvx - nx * dvz, czv = nx * dvy - ny * dvx;
        const dotA2 = cxv * A2x + cyv * A2y + czv * A2z;
        const v7x = dvy * A7z - dvz * A7y, v7y = dvz * A7x - dvx * A7z, v7z = dvx * A7y - dvy * A7x;
        const n3x = ny * A3z - nz * A3y, n3y = nz * A3x - nx * A3z, n3z = nx * A3y - ny * A3x;
        const kk15 = G / (C_SQ * r2raw * Math.sqrt(r2raw));
        const SIdotSJ = SIx * SJx + SIy * SJy + SIz * SJz;
        const nS1 = nx * SIx + ny * SIy + nz * SIz, nS2 = nx * SJx + ny * SJy + nz * SJz;
        const muP = mi * mj / M;
        const kkSS = 3 * G / (C_SQ * muP * r2raw * r2raw);
        const arelX = kk15 * (6 * nx * dotA2 - v7x + 3 * rd15 * n3x)
          + kkSS * (-nx * SIdotSJ + SIx * nS2 + SJx * nS1 - 5 * nx * nS1 * nS2);
        const arelY = kk15 * (6 * ny * dotA2 - v7y + 3 * rd15 * n3y)
          + kkSS * (-ny * SIdotSJ + SIy * nS2 + SJy * nS1 - 5 * ny * nS1 * nS2);
        const arelZ = kk15 * (6 * nz * dotA2 - v7z + 3 * rd15 * n3z)
          + kkSS * (-nz * SIdotSJ + SIz * nS2 + SJz * nS1 - 5 * nz * nS1 * nS2);
        const wi15 = -mj / M, wj15 = mi / M;
        axi += wi15 * arelX; ayi += wi15 * arelY; azi += wi15 * arelZ;
        ax[j] += wj15 * arelX; ay[j] += wj15 * arelY; az[j] += wj15 * arelZ;
        /* 自旋进动（Kidder eq. 2.4）：Ṡ₁ = 1/r³{ (L_N×S₁)(2+3m₂/2m₁) − S₂×S₁
         *   + 3(n̂·S₂)n̂×S₁ }（G/c² 因子，Ṡ=Ω×S 形式幅值守恒）。
         * 力矩向量 dS⃗/dt = Ω×S⃗ 写入 spinT 缓冲（spinVecUpdate 管线：轴转动、|Ω| 不变）*/
        if (spinTx) {
          const LNx = muP * (dy * dvz - dz * dvy), LNy = muP * (dz * dvx - dx * dvz), LNz = muP * (dx * dvy - dy * dvx);
          const kkPre = G / (C_SQ * r2raw * Math.sqrt(r2raw));
          const c1 = 2 + 1.5 * mj / mi, c2 = 2 + 1.5 * mi / mj;
          const Om1x = kkPre * (c1 * LNx - SJx + 3 * nS2 * nx);
          const Om1y = kkPre * (c1 * LNy - SJy + 3 * nS2 * ny);
          const Om1z = kkPre * (c1 * LNz - SJz + 3 * nS2 * nz);
          const Om2x = kkPre * (c2 * LNx - SIx + 3 * nS1 * nx);
          const Om2y = kkPre * (c2 * LNy - SIy + 3 * nS1 * ny);
          const Om2z = kkPre * (c2 * LNz - SIz + 3 * nS1 * nz);
          spinTx[i] += Om1y * SIz - Om1z * SIy; spinTy[i] += Om1z * SIx - Om1x * SIz; spinTz[i] += Om1x * SIy - Om1y * SIx;
          spinTx[j] += Om2y * SJz - Om2z * SJy; spinTy[j] += Om2z * SJx - Om2x * SJz; spinTz[j] += Om2x * SJy - Om2y * SJx;
        }
      }
      if ((tideOn || j2On) && r2raw > pnMin2) {
        /* 潮汐相互作用（平衡潮 CTL）+ J2 旋转扁体 —— 见函数头注释。
         * v35：J2 独立于潮汐开关（MASK_J2），保守进动/章动不依附耗散总开关。
         * v21 物理修正：平衡潮是「外部扰源势的多极展开」——伴星接触/穿入本体
         * （r < R_i+R_j）时前提失效，r⁻⁷ 点质量潮力在穿入段虚假爆涨（用户地月
         * 快合并场景实测：穿入段月潮对地球力 ~10² m/s² ≫ 引力，弹射伴星且
         * 账本破裂，v20 同病）。接触/穿入段属于合并拖曳区（动量守恒 + 账本
         * sinkTideE 闭合），潮汐对整对关闭；r > R_i+R_j 行为逐位不变。 */
        const Rj0 = tideOn ? bodyRadA[j] : 0;
        const rC0 = RI + Rj0, rContact2 = rC0 * rC0;
        if (r2raw <= rContact2) {
          /* 接触/穿入：无平衡潮（拖曳区），仅跳过潮汐块其余部分 */
        } else {
        /* 近距淡入权重：r ∈ [R_i+R_j, 1.6(R_i+R_j)] 平滑升到 1——接触邻域的
         * 点质量 r⁻⁷ 展开不可靠（有限尺寸效应主导），避免每近拱点虚假泵能；
         * 真实地月（47×接触距离）等常规场景权重恒为 1，行为不变。 */
        const rAbs = 1 / invR;                                   /* 分离距离 r（耗散功率用） */
        const wTide = Math.min(1, Math.max(0, (rAbs / rC0 - 1) / 0.6));
        const fTide = wTide * wTide * (3 - 2 * wTide);
        /* 潮汐相互作用（平衡潮 CTL）模型。
         * fij = 潮在 i 上（被 j 掀起）对 j 的力；fji = 潮在 j 上对 i 的力。
         * a_j += (fij − fji)/m_j，a_i += (fji − fij)/m_i → 动量严格守恒；
         * 自转力矩（v19e 起为完整向量）：N⃗ = −cL(r⃗×l⃗)，平行分量改 |Ω|（spinAcc = N⃗·s⃗/I），
         *   垂直分量旋转自转轴 s⃗（Hut 1981 弱摩擦模型的自转向量演化；轴演化在 kick/
         *   stageMidpoint 的 spinVecUpdate 内做 S⃗ = IΩs⃗ ← S⃗ + N⃗τ，|S⃗|→0 时冻结轴防奇异）。
         * v19d 修正：N_j 原为 +（与 N_i 反号）——对 Ω_j > n 的天体成为正反馈
         *   （自转被加速发散；地月 1e7 强失谐场景实测 Ω 发散过零）。CTL 同步化
         *   必须是负反馈 τ ∝ −(Ω−n)（Murray & Dermott §4.7），i/j 两块同号。
         *   r⃗ 恒指 i→j，故 j 的滞后轨道力 fji_lag = −cL(r⃗×l⃗_j) 与 N_j 同构（几何验证：
         *   j 的近侧隆起超前时对 i 的牵引沿 i 的轨道前向 = −l⃗_j 方向）。
         * v19e 修正 1（保守潮 j 块符号）：fji_cons 由 −6Aⱼn̂ 改为 +6Aⱼn̂ —— 牛顿第三定律下
         *   「i 单极 ↔ j 隆起」力对应为（i 上 +6Aⱼn̂，j 上 −6Aⱼn̂），原 − 号使两隆起对相对
         *   运动的贡献相减（等隆起时净力为零，实测探针 dA=0 vs 解析 −0.0235），且与
         *   computeTotalEnergy 的 U₂ = −(U_i+U_j)（两隆起相加）不一致 → 能量账漂移。
         * v19e 修正 2（总角动量闭合）：v19d 起轨道侧用完整滞后力、自转侧却只取轴向投影，
         *   ε≠0 时垂直分量泄漏（实测探针：快自转+60° 倾角 20 轨道 |ΔL|/L 线性漂移 2.2e-4）。
         *   现自转侧也用完整 N⃗（轴演化），闭合 r⃗×(fij−fji) + N⃗_i + N⃗_j = 0 逐位成立。
         * v19e 新增（八极不对称潮）：U₃ = −k₃Gm′²R⁷/r⁸ → F₃ = −8k₃Gm′²R⁷/r⁹·n̂（近/远侧
         *   不对称的最低阶引力高阶项；与 U₂ 同一洛夫数定义体系推导：U_l = −k_lGm′²R^{2l+1}/r^{2l+2}）。
         *   仅保守项（八极滞后耗散相对四极滞后为 (k3/k2)(R/r)² 量级微小修正，忽略）。 */
        const mj = massA[j];
        const nx = dx * invR, ny = dy * invR, nz = dz * invR;
        const rd = dvx * nx + dvy * ny + dvz * nz;
        const vtx = dvx - rd * nx, vty = dvy - rd * ny, vtz = dvz - rd * nz;   /* 横向速度 v⃗_t */
        const invR7 = invR / (r2raw * r2raw * r2raw);           /* 1/r⁷ */
        const invR9 = invR7 / r2raw;                             /* v19e：1/r⁹（八极潮） */
        let fijX = 0, fijY = 0, fijZ = 0, fjiX = 0, fjiY = 0, fjiZ = 0;
        let fLagX = 0, fLagY = 0, fLagZ = 0;                     /* 仅滞后项（账本用） */
        if (A0i > 0 && r2raw > RI * RI) {
          const Ai = A0i * mj * mj * invR7 * fTide;
          const fi2 = 6 * Ai + 8 * bodyTideA03[i] * mj * mj * invR9 * fTide;   /* 保守潮：四极 + 八极 */
          fijX = -fi2 * nx; fijY = -fi2 * ny; fijZ = -fi2 * nz;
          if (lagI > 0) {
            const wx = omI * (siy * nz - siz * ny), wy = omI * (siz * nx - six * nz), wz = omI * (six * ny - siy * nx);
            const lx = wx - vtx * invR, ly = wy - vty * invR, lz = wz - vtz * invR;
            const ll2 = lx * lx + ly * ly + lz * lz;
            let lagScale = lagI;
            if (ll2 > 0 && ll2 * lagI * lagI > TIDE_LAG_MAX * TIDE_LAG_MAX) lagScale = TIDE_LAG_MAX / Math.sqrt(ll2);
            const cL = 3 * Ai * lagScale;
            const cLx = cL * lx, cLy = cL * ly, cLz = cL * lz;
            fijX += cLx; fijY += cLy; fijZ += cLz;
            fLagX = cLx; fLagY = cLy; fLagZ = cLz;
            tideHeatW += cL * ll2 * rAbs;                                /* 耗散功率 = 3AΔt|l⃗|²/r⁶ ≥ 0 */
            /* v19e：完整力矩向量 N⃗_i = −cL(r⃗×l⃗_i)（原只取 (r⃗×l⃗)·s⃗ 轴向投影，
             *   垂直分量被静默丢弃 → 轨道侧带走而自转侧未接收，ε≠0 时 L 泄漏） */
            const Nxc = -cL * (dy * lz - dz * ly), Nyc = -cL * (dz * lx - dx * lz), Nzc = -cL * (dx * ly - dy * lx);
            spinTx[i] += Nxc; spinTy[i] += Nyc; spinTz[i] += Nzc;
            spinAcc[i] += (Nxc * six + Nyc * siy + Nzc * siz) / bodyIA[i];
          }
        }
        if (tideOn && bodyTideA0[j] > 0) {
          const RJ = bodyRadA[j], lagJ = bodyLagA[j], A0j = bodyTideA0[j];
          if (r2raw > RJ * RJ) {
            const Aj = A0j * mi * mi * invR7 * fTide;
            const fj2 = 6 * Aj + 8 * bodyTideA03[j] * mi * mi * invR9;   /* v19e：符号修正 + 八极（见块头注释） */
            fjiX = fj2 * nx; fjiY = fj2 * ny; fjiZ = fj2 * nz;
            if (lagJ > 0) {
              const sjx = spinAxX[j], sjy = spinAxY[j], sjz = spinAxZ[j];
              const omJ = spinRate[j];
              const wx = omJ * (sjy * nz - sjz * ny), wy = omJ * (sjz * nx - sjx * nz), wz = omJ * (sjx * ny - sjy * nx);
              const lx = wx - vtx * invR, ly = wy - vty * invR, lz = wz - vtz * invR;
              const ll2 = lx * lx + ly * ly + lz * lz;
              let lagScale = lagJ;
              if (ll2 > 0 && ll2 * lagJ * lagJ > TIDE_LAG_MAX * TIDE_LAG_MAX) lagScale = TIDE_LAG_MAX / Math.sqrt(ll2);
              const cL = 3 * Aj * lagScale;
              const cLx = cL * lx, cLy = cL * ly, cLz = cL * lz;
              fjiX -= cLx; fjiY -= cLy; fjiZ -= cLz;           /* v19d：fji_lag 反号（与 N_j 同步，见块头注释） */
              fLagX += cLx; fLagY += cLy; fLagZ += cLz;
              tideHeatW += cL * ll2 * rAbs;
              const Mxc = -cL * (dy * lz - dz * ly), Myc = -cL * (dz * lx - dx * lz), Mzc = -cL * (dx * ly - dy * lx);
              spinTx[j] += Mxc; spinTy[j] += Myc; spinTz[j] += Mzc;
              spinAcc[j] += (Mxc * sjx + Myc * sjy + Mzc * sjz) / bodyIA[j];
            }
          }
        }
        const dfx = fijX - fjiX, dfy = fijY - fjiY, dfz = fijZ - fjiZ;
        axi += -dfx / mi; ayi += -dfy / mi; azi += -dfz / mi;
        ax[j] += dfx / mj; ay[j] += dfy / mj; az[j] += dfz / mj;
        if (axTL) {
          axTL[i] += -fLagX / mi; ayTL[i] += -fLagY / mi; azTL[i] += -fLagZ / mi;
          axTL[j] += fLagX / mj; ayTL[j] += fLagY / mj; azTL[j] += fLagZ / mj;
        }
        /* ---- v35：J2 旋转扁体（自转轴进动+章动；独立开关 j2On）----
         * 流体平衡扁率 J2 = (2/3)k2·q，q = Ω²R³/(Gm)（随自旋演化即时计算，自洽）。
         * v35 符号修正（薄环精确级数 + 椭球 GL 求积双重裁决，见 worklog 35-1）：
         *   力矩 N_i = -3G m_i m_j J2_i R_i² (ŝ·n̂)(ŝ×n̂)/r³（负号 → 地球岁差 retrograde）；
         *   轨道四极力 a_j = +K[(5c²-1)n̂ - 2c ŝ]，K = 3Gm_iJ2R²/2r⁴（Vallado 8-57：
         *   赤道面额外吸引、极区减弱；Moon 升交点 regression 18.6y）。
         * 动量守恒（反作用按质量分配）与 r×F = -N 角动量闭合在修正后严格成立；
         * 章动（18.6y 等）由瞬时力矩 + Moon 节点后退自然涌现。
         * 潮汐锁定 ŝ∥n̂ → (ŝ×n̂)=0 力矩自然为零；黑洞 k2=0 → J2=0；r ≤ R 不适用。 */
        if (j2On && bodyK2A[i] > 0 && omI > 0) {
          const RJ2i = bodyRadA[i];
          if (r2raw > RJ2i * RJ2i) {
            const J2i = 2 / 3 * bodyK2A[i] * omI * omI * RJ2i * RJ2i * RJ2i / Gmi;
            const invR3 = invR * invR * invR;   /* 真实 1/r³（不用软化——与潮汐同口径） */
            const cI = six * nx + siy * ny + siz * nz;
            const NtI = 3 * Gmi * mj * J2i * RJ2i * RJ2i * cI * invR3;
            spinTx[i] -= NtI * (siy * nz - siz * ny);
            spinTy[i] -= NtI * (siz * nx - six * nz);
            spinTz[i] -= NtI * (six * ny - siy * nx);
            /* i 的 J2 → j 的加速度 + i 的反作用 */
            const fJ = 5 * cI * cI - 1, Kf = 1.5 * Gmi * J2i * RJ2i * RJ2i * invR3 * invR;
            const gx = Kf * (fJ * nx - 2 * cI * six), gy = Kf * (fJ * ny - 2 * cI * siy), gz = Kf * (fJ * nz - 2 * cI * siz);
            ax[j] += gx; ay[j] += gy; az[j] += gz;
            axi -= gx * (mj / mi); ayi -= gy * (mj / mi); azi -= gz * (mj / mi);
          }
        }
        {
          const omJ2 = spinRate ? spinRate[j] : 0;
          if (j2On && bodyK2A[j] > 0 && omJ2 > 0) {
            const RJ2j = bodyRadA[j];
            if (r2raw > RJ2j * RJ2j) {
              const J2j = 2 / 3 * bodyK2A[j] * omJ2 * omJ2 * RJ2j * RJ2j * RJ2j / (G * mj);
              const invR3 = invR * invR * invR;
              const sjx = spinAxX[j], sjy = spinAxY[j], sjz = spinAxZ[j];
              const cJ = sjx * nx + sjy * ny + sjz * nz;
              const NtJ = 3 * G * mj * mi * J2j * RJ2j * RJ2j * cJ * invR3;
              spinTx[j] -= NtJ * (sjy * nz - sjz * ny);
              spinTy[j] -= NtJ * (sjz * nx - sjx * nz);
              spinTz[j] -= NtJ * (sjx * ny - sjy * nx);
              /* j 的 J2 → i 的加速度 + j 的反作用（n̂ 换向的符号已并入推导） */
              const fJj = 5 * cJ * cJ - 1, Kfj = 1.5 * G * mj * J2j * RJ2j * RJ2j * invR3 * invR;
              const hx = Kfj * (fJj * nx - 2 * cJ * sjx), hy = Kfj * (fJj * ny - 2 * cJ * sjy), hz = Kfj * (fJj * nz - 2 * cJ * sjz);
              axi -= hx; ayi -= hy; azi -= hz;
              ax[j] += hx * (mi / mj); ay[j] += hy * (mi / mj); az[j] += hz * (mi / mj);
            }
          }
        }
        }
      }
    }
    ax[i] += axi; ay[i] += ayi; az[i] += azi;
  }
  if (gr1pnOn) {
    /* ---- 1PN 成对修正（调和规范两体相对式，两文献来源互证 + 水星 42.98″/世纪验证）----
     * a_rel = −GM/r²n̂ + GM/(c²r²){ n̂[(4+2η)GM/r − (1+3η)v² + (3/2)ηṙ²] + (4−2η)ṙv }
     * 以 (m_j/M, −m_i/M) 加权分配 → 动量严格守恒。
     * v7 调研说明：EIH 完整 N 体跨体交叉项（Will PRL 120, 191101 (2018)，水星 ~1e-6
     * 相对效应）需按 Moyer/Poisson-Will 教科书式 (9.127) 实现——本版本调研了公开
     * 转录（Wikipedia EIH 条目），数值验证发现其对不等质量系统的 v² 系数与两体
     * 精确解不符（仅在等质量时退化一致），未获得可验证的闭式实现，故暂不实施，
     * 以保证所有已实施物理项均经过强场/观测验证。列入 v8 路线图。 */
    for (let i = 0; i < N; i++) {
      const xi = px[i], yi = py[i], zi = pz[i], mi = massA[i];
      for (let j = i + 1; j < N; j++) {
        const dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi;
        const r2raw = dx * dx + dy * dy + dz * dz;
        if (r2raw <= PN_TIDE_R_MIN * PN_TIDE_R_MIN) continue;
        const dvx = vx[j] - vx[i], dvy = vy[j] - vy[i], dvz = vz[j] - vz[i];
        const invR = 1 / Math.sqrt(r2raw);
        const v2 = dvx * dvx + dvy * dvy + dvz * dvz;
        const mj = massA[j], M = mi + mj;
        const nx = dx * invR, ny = dy * invR, nz = dz * invR;
        const rd = dvx * nx + dvy * ny + dvz * nz;
        const eta = (mi * mj) / (M * M);
        const invR3v = invR / r2raw;
        const GMr = G * M * invR;
        const k = G * M / (C_SQ * r2raw);
        const A = k * ((4 + 2 * eta) * GMr - (1 + 3 * eta) * v2 + 1.5 * eta * rd * rd);
        const B = k * (4 - 2 * eta) * rd;
        /* 主循环已加牛顿项，此处只加 1PN 修正（bx/by/bz 牛顿项不再重复计入） */
        const arx = nx * A + dvx * B;
        const ary = ny * A + dvy * B;
        const arz = nz * A + dvz * B;
        const wi = -mj / M, wj = mi / M;
        ax[i] += wi * arx; ay[i] += wi * ary; az[i] += wi * arz;
        ax[j] += wj * arx; ay[j] += wj * ary; az[j] += wj * arz;
      }
    }
  }
  for (let i = 0; i < N; i++) {
    const a2 = ax[i] * ax[i] + ay[i] * ay[i] + az[i] * az[i];
    if (a2 > maxAccMag) maxAccMag = a2;
  }
  maxAccMag = Math.sqrt(maxAccMag);
}


/* ===== 物理核区块 HTML L2856-L3607（原样） ===== */


/* ---------------- 积分器 ----------------
 * 2.5PN 瞬时力与潮汐力均已并入 computeAccel（速度相关项与 1PN 同样处理），
 * 踢步内同步演化自转：Ω̇ = spinAcc（潮汐力矩/转动惯量，computeAccel 内累加）。
 * 自转为耗散自由度，与 1PN/2.5PN 一样不破坏辛积分器的长期行为监控框架。 */
function drift(tau) {
  for (let i = 0; i < N; i++) {
    kahanAdd(px, cpx, i, vx[i] * tau);
    kahanAdd(py, cpy, i, vy[i] * tau);
    kahanAdd(pz, cpz, i, vz[i] * tau);
  }
}
function kick(tau) {
  for (let i = 0; i < N; i++) {
    kahanAdd(vx, cvx, i, ax[i] * tau);
    kahanAdd(vy, cvy, i, ay[i] * tau);
    kahanAdd(vz, cvz, i, az[i] * tau);
  }
  /* 自转相位同步积分（v19c）：Δφ = ∫Ωdt ≈ (Ω₀+ΔΩ/2)τ 梯形；Ω 恒定时退化为 Ωτ。
   * v21：1.5PN 自旋开启时力矩含进动项（spinT 缓冲），同样走 spinVecUpdate */
  if (spinPhase) {
    if ((tideOn || gr15spinOn || j2On) && spinAcc && spinTx) {
      for (let i = 0; i < N; i++) {
        kahanAdd(spinPhase, cspinPhase, i, (spinRate[i] + 0.5 * spinAcc[i] * tau) * tau);
        spinVecUpdate(i, tau);          /* v19e：S⃗ = IΩs⃗ ← S⃗ + N⃗τ（轴随力矩演化） */
      }
    } else {
      for (let i = 0; i < N; i++) kahanAdd(spinPhase, cspinPhase, i, spinRate[i] * tau);
    }
  }
  /* ---- v7 守恒量账本累积（每半踢/子步）----
   * 耗散力做功 = Σ m a_D·(v + a_total·τ/2)·τ（中点速度二阶估计）；
   * GW 辐射角动量 = −Σ m (r⃗×a_RR)·τ；潮汐自转功 = Σ IΩ·Ω̇·τ。
   * 潮汐部分应与 ∫tideHeatW dt 一致（T12 交叉验证）。 */
  if (axRR && tau !== 0) {
    let wrr = 0, wtl = 0, lrx = 0, lry = 0, lrz = 0, fpX = 0, fpY = 0, fpZ = 0;
    for (let i = 0; i < N; i++) {
      const vmx = vx[i] + 0.5 * ax[i] * tau;
      const vmy = vy[i] + 0.5 * ay[i] * tau;
      const vmz = vz[i] + 0.5 * az[i] * tau;
      wrr -= massA[i] * (axRR[i] * vmx + ayRR[i] * vmy + azRR[i] * vmz) * tau;
      wtl -= massA[i] * (axTL[i] * vmx + ayTL[i] * vmy + azTL[i] * vmz) * tau;
      lrx -= massA[i] * (py[i] * azRR[i] - pz[i] * ayRR[i]) * tau;
      lry -= massA[i] * (pz[i] * axRR[i] - px[i] * azRR[i]) * tau;
      lrz -= massA[i] * (px[i] * ayRR[i] - py[i] * axRR[i]) * tau;
      fpX += massA[i] * ax[i]; fpY += massA[i] * ay[i]; fpZ += massA[i] * az[i];
    }
    if (tideOn && spinAcc) {
      for (let i = 0; i < N; i++) wtl -= bodyIA[i] * spinRate[i] * spinAcc[i] * tau;
    }
    sinkGWE[0] += wrr; sinkTideE[0] += wtl;
    sinkGWLx[0] += lrx; sinkGWLv[0] += lry; sinkGWLz[0] += lrz;
    fieldPx[0] -= fpX * tau; fieldPv[0] -= fpY * tau; fieldPz[0] -= fpZ * tau;
  }
}
/* ---------------- v19 隐式中点阶段 ----------------
 * 速度相关力（1PN/2PN 保守 + 2.5PN/3.5PN 辐射 + 潮汐）的逐阶段积分。
 *
 * 为什么弃用 KDK（v19 数值调研，Python 全链复刻，见 scripts/pn_test*.py / pn_midpoint.py）：
 * 时间反演 R(x,v)=(x,−v) 下 1PN 力为 v-偶（ṙ·v 项在 v→−v 下不变号），流动可逆；
 * 但「踢映射」T: v ↦ v + F(x,v)·τ/2 的逆映射在 F 的求值点上与 R·T·R 不同——
 *   R·T·R 的隐式方程在「未知量」处求 F，而 T 的显式逆在「已知输出」处求 F，
 *   两者差 O(τ²·(∂F/∂v)·F)（本场景 ≈ 每半踢数 m/s）。无论踢是显式还是隐式
 *   固定点求解，该残差都存在 → 每步注入微小单向能量误差 → secular 泵送。
 *   实测（20+20 M☉ 致密双星 a=1.5e7 m，近星点 γ=GM/rc²≈5.7e-3）：
 *   固定步长 τ=2.14e-3 s 40 轨道 ΔE/E₀ = +5.0%（显式）/-5.8%（隐式踢）；
 *   自适应步长 +2.5%（显式）/-2.6%（隐式踢）—— 均单调漂移（用户报告的「1PN 泵能」）。
 * 隐式中点 z₁ = z₀ + τ·f((z₀+z₁)/2) 对可逆流满足 R·Φ·R = Φ⁻¹（固定点逐位收敛后
 *   逐位成立），能量误差有界：同场景 40 轨道 max|ΔE/E₀| = 6.7e-4（1PN）、
 *   6.4e-6（1PN+2PN），200 轨道不增长；动量/角动量由成对反对称力逐位守恒。
 *   文献：Hairer-Lubich-Wanner《Geometric Numerical Integration》对称法/BEA；
 *   Mikkola & Merritt (2006, MNRAS 372, 219; 2008, AJ 135, 2398) PN 项需
 *   时间对称/哈密顿框架处理（他们用 KS 正则化 + 时间对称算法）—— 同结论。 */
const MID_MAX_ITER = 8;
let mpIterLast = 0;                       // 调试：最近一次阶段迭代数
let mpConvLast = true;                    // v31：最近一次阶段是否收敛（不收敛 → 自适应路径折半重做）
function stageMidpoint(tau) {
  if (N === 0) { mpConvLast = true; return; }
  if (tau === 0) { mpConvLast = true; return; }
  /* 全局统计快照（试探求值会改写 minR2/maxAccMag/minPairM/minPairV2/tideHeatW；
   * spinAcc 由迭代最后一轮写入收敛力矩，commit 直接使用，步尾 computeAccel 再刷新） */
  const sR2 = minR2, sAM = maxAccMag, sPM = minPairM, sPV2 = minPairV2, sTH = tideHeatW;
  /* v19f：循环拷贝代替 subarray 分配（位级同值）；包装数组按缓冲版本缓存 */
  if (_mpWrapVer !== bufVer) {
    _wMP[0] = mpPx; _wMP[1] = mpPy; _wMP[2] = mpPz;
    _wMV[0] = mpVx; _wMV[1] = mpVy; _wMV[2] = mpVz;
    _wMA[0] = mpAx; _wMA[1] = mpAy; _wMA[2] = mpAz;
    _wMR[0] = mpRX; _wMR[1] = mpRY; _wMR[2] = mpRZ;
    _wMT[0] = mpTX; _wMT[1] = mpTY; _wMT[2] = mpTZ;
    _mpWrapVer = bufVer;
  }
  for (let i = 0; i < N; i++) {
    const xi = px[i], yi = py[i], zi = pz[i], vxi = vx[i], vyi = vy[i], vzi = vz[i];
    mpPx[i] = xi; mpPy[i] = yi; mpPz[i] = zi;
    mpVx[i] = vxi; mpVy[i] = vyi; mpVz[i] = vzi;
    mpPnX[i] = xi; mpPnY[i] = yi; mpPnZ[i] = zi;
    mpVnX[i] = vxi; mpVnY[i] = vyi; mpVnZ[i] = vzi;
  }
  let it = 0, convOk = false;   /* v31：收敛标志外露（不收敛 → 调用方折半重做） */
  for (; it < MID_MAX_ITER; it++) {
    accumulateAccel(_wMP, _wMV, _wMA, _wMR, _wMT, spinAcc);
    /* p1 = p0 + vm·τ；v1 = v0 + a(pm,vm)·τ；中点 = (p0+p1)/2, (v0+v1)/2 */
    for (let i = 0; i < N; i++) {
      mpPnX[i] = (px[i] + (px[i] + mpVx[i] * tau)) / 2;
      mpPnY[i] = (py[i] + (py[i] + mpVy[i] * tau)) / 2;
      mpPnZ[i] = (pz[i] + (pz[i] + mpVz[i] * tau)) / 2;
      mpVnX[i] = (vx[i] + (vx[i] + mpAx[i] * tau)) / 2;
      mpVnY[i] = (vy[i] + (vy[i] + mpAy[i] * tau)) / 2;
      mpVnZ[i] = (vz[i] + (vz[i] + mpAz[i] * tau)) / 2;
    }
    /* v20 收敛检测（两级）：先逐位自洽（严格可逆），再按相对容差 4e-16 提前退出。
     * Python 等价性验证（scripts/physics_perf_test.py A）：1PN 双体 400 步轨迹
     * 与能量逐位一致 —— 容差级 4e-16 位于双精度舍入噪声水平，效果一致但
     * 免去最后一次「确认性」全量力求值（速度相关力路径实测显著减少迭代）。 */
    let same = true;
    for (let i = 0; i < N && same; i++) {
      if (mpPnX[i] !== mpPx[i] || mpPnY[i] !== mpPy[i] || mpPnZ[i] !== mpPz[i] ||
          mpVnX[i] !== mpVx[i] || mpVnY[i] !== mpVy[i] || mpVnZ[i] !== mpVz[i]) same = false;
    }
    if (same) { convOk = true; break; }
    if (it >= 1) {
      let conv = true;
      for (let i = 0; i < N && conv; i++) {
        const pxR = Math.abs(mpPx[i]) + 1e-30, pyR = Math.abs(mpPy[i]) + 1e-30, pzR = Math.abs(mpPz[i]) + 1e-30;
        const vxR = Math.abs(mpVx[i]) + 1e-30, vyR = Math.abs(mpVy[i]) + 1e-30, vzR = Math.abs(mpVz[i]) + 1e-30;
        if (Math.abs(mpPnX[i] - mpPx[i]) / pxR > 4e-16 || Math.abs(mpPnY[i] - mpPy[i]) / pyR > 4e-16 ||
            Math.abs(mpPnZ[i] - mpPz[i]) / pzR > 4e-16 ||
            Math.abs(mpVnX[i] - mpVx[i]) / vxR > 4e-16 || Math.abs(mpVnY[i] - mpVy[i]) / vyR > 4e-16 ||
            Math.abs(mpVnZ[i] - mpVz[i]) / vzR > 4e-16) conv = false;
      }
      if (conv) { it++; convOk = true; break; }
    }
    for (let i = 0; i < N; i++) {
      mpPx[i] = mpPnX[i]; mpPy[i] = mpPnY[i]; mpPz[i] = mpPnZ[i];
      mpVx[i] = mpVnX[i]; mpVy[i] = mpVnY[i]; mpVz[i] = mpVnZ[i];
    }
  }
  mpIterLast = it + 1;
  mpConvLast = convOk;   /* v31：耗尽 MID_MAX_ITER 仍未收敛 → false（固定步长路径照旧提交并计数） */
  /* 提交：x₁ = x₀ + vm·τ；v₁ = v₀ + a(pm,vm)·τ；自转 Ω += ζ(pm,vm)·τ */
  for (let i = 0; i < N; i++) {
    kahanAdd(px, cpx, i, mpVx[i] * tau);
    kahanAdd(py, cpy, i, mpVy[i] * tau);
    kahanAdd(pz, cpz, i, mpVz[i] * tau);
    kahanAdd(vx, cvx, i, mpAx[i] * tau);
    kahanAdd(vy, cvy, i, mpAy[i] * tau);
    kahanAdd(vz, cvz, i, mpAz[i] * tau);
    /* 自转相位同步积分（v19c，与 kick 同式）：Ω₀τ + ζτ²/2；v21 进动随 spinT 管线 */
    if (spinPhase) {
      if ((tideOn || gr15spinOn || j2On) && spinAcc && spinTx) {
        const zeta = spinAcc[i];
        kahanAdd(spinPhase, cspinPhase, i, (spinRate[i] + 0.5 * zeta * tau) * tau);
        spinVecUpdate(i, tau);            /* v19e：自转向量演化（与 kick 同式） */
      } else {
        kahanAdd(spinPhase, cspinPhase, i, spinRate[i] * tau);
      }
    }
  }
  /* ---- v7 守恒量账本（中点态精确累积，替代 kick() 的 (v+aτ/2) 估计） ----
   * 耗散力做功 = Σ m·a_D·vm·τ；GW 辐射角动量 = −Σ m·(rm×a_RR)·τ；
   * 潮汐自转功 = Σ I·Ω_mid·ζ·τ；PN 场动量账本 = −Σ m·a·τ。 */
  if (axRR && tau !== 0) {
    let wrr = 0, wtl = 0, lrx = 0, lry = 0, lrz = 0, fpX = 0, fpY = 0, fpZ = 0;
    for (let i = 0; i < N; i++) {
      wrr -= massA[i] * (mpRX[i] * mpVx[i] + mpRY[i] * mpVy[i] + mpRZ[i] * mpVz[i]) * tau;
      wtl -= massA[i] * (mpTX[i] * mpVx[i] + mpTY[i] * mpVy[i] + mpTZ[i] * mpVz[i]) * tau;
      lrx -= massA[i] * (mpPy[i] * mpRZ[i] - mpPz[i] * mpRY[i]) * tau;
      lry -= massA[i] * (mpPz[i] * mpRX[i] - mpPx[i] * mpRZ[i]) * tau;
      lrz -= massA[i] * (mpPx[i] * mpRY[i] - mpPy[i] * mpRX[i]) * tau;
      fpX += massA[i] * mpAx[i]; fpY += massA[i] * mpAy[i]; fpZ += massA[i] * mpAz[i];
    }
    if (tideOn && spinAcc) {
      /* Ω_mid = Ω(commit 后) − 0.5·ζ·τ（重建中点自转角速度） */
      for (let i = 0; i < N; i++) wtl -= bodyIA[i] * (spinRate[i] - 0.5 * spinAcc[i] * tau) * spinAcc[i] * tau;
    }
    sinkGWE[0] += wrr; sinkTideE[0] += wtl;
    sinkGWLx[0] += lrx; sinkGWLv[0] += lry; sinkGWLz[0] += lrz;
    fieldPx[0] -= fpX * tau; fieldPv[0] -= fpY * tau; fieldPz[0] -= fpZ * tau;
  }
  /* 恢复全局统计（commit 后由 step 尾部的 computeAccel 刷新为真实态） */
  minR2 = sR2; maxAccMag = sAM; minPairM = sPM; minPairV2 = sPV2; tideHeatW = sTH;
}
/* v19e：自转向量演化一步。S⃗ = IΩs⃗，dS⃗/dt = N⃗（完整潮汐力矩向量）。
 * 平行分量改 |Ω|，垂直分量旋转 s⃗（倾角演化/进动，Hut 1981 弱摩擦模型）。
 * 以 S⃗ 为主状态避免 Ω→0 的 s⃗̇ 奇异（Ω=|S⃗|/I ≥ 0，方向全由 s⃗ 承载，倒转自转
 * 等价于 s⃗ 翻转）；|S⃗|→0（自转精确归零）时冻结轴。Ω 恒定时退化为原 Ω+=Ω̇τ。 */
function spinVecUpdate(i, tau) {
  const I = bodyIA[i];
  const Sx = I * spinRate[i] * spinAxX[i] + spinTx[i] * tau;
  const Sy = I * spinRate[i] * spinAxY[i] + spinTy[i] * tau;
  const Sz = I * spinRate[i] * spinAxZ[i] + spinTz[i] * tau;
  const Sm = Math.sqrt(Sx * Sx + Sy * Sy + Sz * Sz);
  if (Sm > 1e-300) {
    spinRate[i] = Sm / I;
    spinAxX[i] = Sx / Sm; spinAxY[i] = Sy / Sm; spinAxZ[i] = Sz / Sm;
  }
}
/* ---------------- v21/v31 IAS15 积分器（替换 2 阶 Verlet） ----------------
 * 15 阶 Gauss-Radau 预测-校正（Rein & Spiegel 2015；常数表 = REBOUND 5.1.1）。
 * 常数 h/rr/c/d 见文件头常量区；算法要点（Python 已验证 scripts/v21_physics_test.py A）：
 *   ① b 预测器在「提交后」按 dtNext/h 预测（v31 起与 REBOUND 完全同构：Everhart
 *      e 外推 + b−e 修正，替代 v21-v30 的步首纯 q^k 缩放——外推项是 IAS15 高阶来源）；
 *   ② 7 个内部点求值与 case 1..7 的 b 更新交错（点 n 的 b 更新参与点 n+1 预测）；
 *   ③ 收敛判据（v31）= max|Δb₆|/max|a(末内部点)|（REBOUND 同式），<1e-16/振荡/12 次止；
 *   ④ 自适应步长（v31）= REBOUND 全套：PRS23/GLOBAL 误差估计 → dt_new，欲缩 >4×
 *      整步拒绝回滚重做，欲增封顶 4×，min_dt 地板；由 stepIAS15Adaptive 驱动重试；
 *   ⑤ 位置/速度终值经 Kahan 补偿提交（/6 /12 /20 /30 /42 /56 /72 与 /2 /3 /4 /5 /6 /7 /8）；
 *   ⑥ 自旋（相位/向量）与账本（辐射功/GW 角动量/场动量/潮汐热）按 IAS_W 权重在内部点
 *      Radau 积分——账本与 kick() 路径同一物理量（GW 功 = −Σm·a_RR·v·τ 等），
 *      账本累加在拒绝重试时不重复入账（局部累加器，接受才提交）。 */
function iasEnsureBuffers() {
  const need = 3 * CAP;
  if (iasCap >= need) return;
  iasB = []; iasGt = []; iasSnapB = []; iasE = []; iasLastB = []; iasLastE = [];
  for (let k = 0; k < 7; k++) {
    iasB.push(new Float64Array(need)); iasGt.push(new Float64Array(need)); iasSnapB.push(new Float64Array(need));
    iasE.push(new Float64Array(need)); iasLastB.push(new Float64Array(need)); iasLastE.push(new Float64Array(need));
  }
  iasX0 = new Float64Array(need); iasV0 = new Float64Array(need); iasA0 = new Float64Array(need);
  iasXT = new Float64Array(need); iasVT = new Float64Array(need); iasAT = new Float64Array(need);
  iasCSx = new Float64Array(need); iasCSv = new Float64Array(need);
  iasSpinT = new Float64Array(3 * need); iasSpinZ = new Float64Array(need);
  iasCap = need; iasReady = false; iasN3 = -1;   // 缓冲重建后预测器失效
}
const IAS_ITER_MAX = 12;
/* v31：Everhart 预测器（REBOUND predict_next_step 逐式移植）。
 * e_new = q^k·(b 的二项式组合)；b_new = e_new + (b_old − e_old)（b−e 修正项）。
 * ratio > 20 时预测器清零（与 REBOUND 同）。源/目标分离：接受步用 (lastB,lastE)→(B,E)，
 * 拒绝步从同一源按新 ratio 重排——避免二次预测失真。 */
function iasPredictNextStep(ratio, n3, srcB, srcE, dstB, dstE) {
  if (ratio > 20) {
    for (let k = 0; k < 7; k++) { dstB[k].fill(0, 0, n3); dstE[k].fill(0, 0, n3); }
    return;
  }
  const q1 = ratio, q2 = q1 * q1, q3 = q1 * q2, q4 = q2 * q2, q5 = q2 * q3, q6 = q3 * q3, q7 = q3 * q4;
  for (let i = 0; i < n3; i++) {
    const b0 = srcB[0][i], b1 = srcB[1][i], b2 = srcB[2][i], b3 = srcB[3][i];
    const b4 = srcB[4][i], b5 = srcB[5][i], b6 = srcB[6][i];
    const be0 = b0 - srcE[0][i], be1 = b1 - srcE[1][i], be2 = b2 - srcE[2][i], be3 = b3 - srcE[3][i];
    const be4 = b4 - srcE[4][i], be5 = b5 - srcE[5][i], be6 = b6 - srcE[6][i];
    dstE[0][i] = q1 * (b6 * 7 + b5 * 6 + b4 * 5 + b3 * 4 + b2 * 3 + b1 * 2 + b0);
    dstE[1][i] = q2 * (b6 * 21 + b5 * 15 + b4 * 10 + b3 * 6 + b2 * 3 + b1);
    dstE[2][i] = q3 * (b6 * 35 + b5 * 20 + b4 * 10 + b3 * 4 + b2);
    dstE[3][i] = q4 * (b6 * 35 + b5 * 15 + b4 * 5 + b3);
    dstE[4][i] = q5 * (b6 * 21 + b5 * 6 + b4);
    dstE[5][i] = q6 * (b6 * 7 + b5);
    dstE[6][i] = q7 * b6;
    dstB[0][i] = dstE[0][i] + be0; dstB[1][i] = dstE[1][i] + be1; dstB[2][i] = dstE[2][i] + be2;
    dstB[3][i] = dstE[3][i] + be3; dstB[4][i] = dstE[4][i] + be4; dstB[5][i] = dstE[5][i] + be5;
    dstB[6][i] = dstE[6][i] + be6;
  }
}
/* v31：IAS15 单步尝试（REBOUND ias15.c step_try 忠实移植）。
 * 返回 { acc, dtNext }：acc=true 该步已提交（px/vx 为终态，simTime 由调用方推进），
 * dtNext = 误差监控建议的下步步长（已含 4× 增长帽与 min_dt 地板）；
 * acc=false 步被拒绝（状态已回滚步首、预测器按 dtNext 重排），dtNext < IAS_SAFETY·h。
 * fixed=true（旧接口兼容）：跳过误差决策，dt 恒定（REBOUND epsilon=0 语义）。
 * 收敛判据对齐 REBOUND：max|Δb₆| / max|a(末内部点)|（v30 及以前用步首 a₀ 归一，
 * 速度相关力下末点更贴近真残差）；迭代止于 <1e-16 / 振荡 / 12 次。 */
function iasStepTry(h, refreshStats, fixed) {
  if (globalThis.__ENGINE__ && __ENGINE__.active && __ENGINE__.iasStepTry) return __ENGINE__.iasStepTry(h, refreshStats, fixed);   /* v34b: WASM 整步派发（iasTry 逐位移植） */
  if (N === 0) return { acc: true, dtNext: h };
  iasEnsureBuffers();
  const n3 = 3 * N;
  if (!iasReady) {
    for (let k = 0; k < 7; k++) { iasB[k].fill(0, 0, n3); iasE[k].fill(0, 0, n3); iasLastB[k].fill(0, 0, n3); iasLastE[k].fill(0, 0, n3); }
    iasCSx.fill(0, 0, n3); iasCSv.fill(0, 0, n3);
    iasReady = true;
  }
  if (iasN3 !== n3) { iasN3 = n3; iasReady = false; for (let k = 0; k < 7; k++) { iasB[k].fill(0, 0, n3); iasE[k].fill(0, 0, n3); } }
  /* 基准态（回滚源：位置/速度；预测器回滚源 = iasLastB/LastE = 上接受步提交后真值） */
  for (let i = 0; i < N; i++) { iasX0[3 * i] = px[i]; iasX0[3 * i + 1] = py[i]; iasX0[3 * i + 2] = pz[i]; }
  for (let i = 0; i < N; i++) { iasV0[3 * i] = vx[i]; iasV0[3 * i + 1] = vy[i]; iasV0[3 * i + 2] = vz[i]; }
  computeAccel();
  for (let i = 0; i < N; i++) {
    iasA0[3 * i] = ax[i]; iasA0[3 * i + 1] = ay[i]; iasA0[3 * i + 2] = az[i];
  }
  /* b→g 预测（IAS_D 表） */
  const B = iasB, Gt = iasGt, D = IAS_D;
  for (let i = 0; i < n3; i++) {
    Gt[0][i] = B[6][i] * D[15] + B[5][i] * D[10] + B[4][i] * D[6] + B[3][i] * D[3] + B[2][i] * D[1] + B[1][i] * D[0] + B[0][i];
    Gt[1][i] = B[6][i] * D[16] + B[5][i] * D[11] + B[4][i] * D[7] + B[3][i] * D[4] + B[2][i] * D[2] + B[1][i];
    Gt[2][i] = B[6][i] * D[17] + B[5][i] * D[12] + B[4][i] * D[8] + B[3][i] * D[5] + B[2][i];
    Gt[3][i] = B[6][i] * D[18] + B[5][i] * D[13] + B[4][i] * D[9] + B[3][i];
    Gt[4][i] = B[6][i] * D[19] + B[5][i] * D[14] + B[4][i];
    Gt[5][i] = B[6][i] * D[20] + B[5][i];
    Gt[6][i] = B[6][i];
  }
  /* 全局统计快照（内部点试探求值会改写） */
  const sR2 = minR2, sAM = maxAccMag, sPM = minPairM, sPV2 = minPairV2, sTH = tideHeatW;
  /* 账本/自旋累加器（预分配，零 GC） */
  let ledRR = 0, ledTL = 0, ledLRx = 0, ledLRy = 0, ledLRz = 0, ledPx = 0, ledPy = 0, ledPz = 0;
  const spinIx = (tideOn || gr15spinOn || j2On) && spinTx ? iasSpinT : null;
  const spinAxAcc = (tideOn || gr15spinOn || j2On) && spinAcc ? iasSpinZ : null;
  let err = 1e300, errLast = 2, iters = 0;
  let adlMax = 0, trialA = 0;   /* v31：|Δb₆| 与末内部点 |a|（REBOUND at 归一） */
  while (true) {
    if (err < 1e-16) break;
    if (iters > 2 && errLast <= err) break;
    if (iters >= IAS_ITER_MAX) break;
    /* v32 关键修复：账本/自旋累加器必须在每次实际迭代前重置——原 v31 在迭代循环
     * 外清零、循环内累加，收敛需 2~4 次迭代时 GW 辐射/潮汐热/辐射角动量/场动量
     * 与自旋 Radau 积分全部被重复计入 2~4 倍（T46 E(x) 平衡 690% 的根因，也是
     * 用户「IAS 路径能量/角动量不守恒」的直接来源）。REBOUND 无账本故无此问题；
     * Yoshida 路径的 stageMidpoint 在收敛后单次入账本就正确。位置在三个 break
     * 之后 = 只有真正执行迭代才清零，提前退出保留上一完整迭代的入账。 */
    ledRR = 0; ledTL = 0; ledLRx = 0; ledLRy = 0; ledLRz = 0; ledPx = 0; ledPy = 0; ledPz = 0;
    if (spinIx) spinIx.fill(0, 0, 3 * N);
    if (spinAxAcc) spinAxAcc.fill(0, 0, N);
    errLast = err; err = 0; iters++; adlMax = 0;
    for (let nn = 1; nn <= 7; nn++) {
      const hn = IAS_H[nn];
      /* 位置/速度预测（REBOUND Horner） */
      for (let i = 0; i < n3; i++) {
        const t1 = B[6][i] * (7 * hn / 9) + B[5][i], t2 = t1 * (3 * hn / 4) + B[4][i];
        const t3 = t2 * (5 * hn / 7) + B[3][i], t4 = t3 * (2 * hn / 3) + B[2][i];
        const t5 = t4 * (3 * hn / 5) + B[1][i], t6 = t5 * (hn / 2) + B[0][i];
        const t7 = t6 * (hn / 3) + iasA0[i], t8 = t7 * h * hn / 2 + iasV0[i];
        iasXT[i] = t8 * h * hn;    /* 增量约定：提交/求值时统一 + iasX0/iasV0（勿混绝对量） */
        const u1 = B[6][i] * (7 * hn / 8) + B[5][i], u2 = u1 * (6 * hn / 7) + B[4][i];
        const u3 = u2 * (5 * hn / 6) + B[3][i], u4 = u3 * (4 * hn / 5) + B[2][i];
        const u5 = u4 * (3 * hn / 4) + B[1][i], u6 = u5 * (2 * hn / 3) + B[0][i];
        const u7 = u6 * (hn / 2) + iasA0[i];
        iasVT[i] = u7 * h * hn;
      }
      for (let i = 0; i < N; i++) {
        px[i] = iasX0[3 * i] + iasXT[3 * i]; py[i] = iasX0[3 * i + 1] + iasXT[3 * i + 1]; pz[i] = iasX0[3 * i + 2] + iasXT[3 * i + 2];
        vx[i] = iasV0[3 * i] + iasVT[3 * i]; vy[i] = iasV0[3 * i + 1] + iasVT[3 * i + 1]; vz[i] = iasV0[3 * i + 2] + iasVT[3 * i + 2];
      }
      accumulateAccel(_wP, _wV, _wA, axRR ? _wRR : null, axTL ? _wTL : null, spinAcc);
      if (nn === 7) trialA = maxAccMag;   /* v31：末内部点试探力模（归一化基准，REBOUND at） */
      /* 账本/自旋按 IAS_W 权重累加（内部点试探真值；与 kick() 路径同一物理量） */
      {
        const wgt = IAS_W[nn];
        if (axRR) {
          for (let i = 0; i < N; i++) {
            ledRR -= massA[i] * (axRR[i] * vx[i] + ayRR[i] * vy[i] + azRR[i] * vz[i]);
            ledLRx -= massA[i] * (py[i] * azRR[i] - pz[i] * ayRR[i]);
            ledLRy -= massA[i] * (pz[i] * axRR[i] - px[i] * azRR[i]);
            ledLRz -= massA[i] * (px[i] * ayRR[i] - py[i] * axRR[i]);
            ledPx += massA[i] * ax[i]; ledPy += massA[i] * ay[i]; ledPz += massA[i] * az[i];
          }
        }
        if (axTL) {
          for (let i = 0; i < N; i++) ledTL -= massA[i] * (axTL[i] * vx[i] + ayTL[i] * vy[i] + azTL[i] * vz[i]);
        }
        if (spinAxAcc && spinAcc) {
          for (let i = 0; i < N; i++) spinAxAcc[i] += wgt * spinAcc[i];
        }
        if (spinIx && spinTx) {
          for (let i = 0; i < N; i++) {
            spinIx[3 * i] += wgt * spinTx[i]; spinIx[3 * i + 1] += wgt * spinTy[i]; spinIx[3 * i + 2] += wgt * spinTz[i];
          }
        }
      }
      /* case nn 更新（REBOUND 字面展开，a_N = a(点n) − a₀）。
       * 试探加速度在 accumulateAccel 后位于真实 ax/ay/az（_wA 包装），逐分量读取 */
      for (let i = 0; i < n3; i++) {
        const c3 = i % 3, ib = (i - c3) / 3;
        const aN = (c3 === 0 ? ax[ib] : c3 === 1 ? ay[ib] : az[ib]) - iasA0[i];
        if (nn === 1) {
          const tmp = Gt[0][i]; Gt[0][i] = aN / IAS_RR[0];
          const dl = Gt[0][i] - tmp; B[0][i] += dl;
        } else if (nn === 2) {
          const tmp = Gt[1][i]; Gt[1][i] = (aN / IAS_RR[1] - Gt[0][i]) / IAS_RR[2];
          const dl = Gt[1][i] - tmp; B[0][i] += dl * IAS_C[0]; B[1][i] += dl;
        } else if (nn === 3) {
          const tmp = Gt[2][i]; Gt[2][i] = ((aN / IAS_RR[3] - Gt[0][i]) / IAS_RR[4] - Gt[1][i]) / IAS_RR[5];
          const dl = Gt[2][i] - tmp; B[0][i] += dl * IAS_C[1]; B[1][i] += dl * IAS_C[2]; B[2][i] += dl;
        } else if (nn === 4) {
          const tmp = Gt[3][i]; Gt[3][i] = (((aN / IAS_RR[6] - Gt[0][i]) / IAS_RR[7] - Gt[1][i]) / IAS_RR[8] - Gt[2][i]) / IAS_RR[9];
          const dl = Gt[3][i] - tmp; B[0][i] += dl * IAS_C[3]; B[1][i] += dl * IAS_C[4]; B[2][i] += dl * IAS_C[5]; B[3][i] += dl;
        } else if (nn === 5) {
          const tmp = Gt[4][i]; Gt[4][i] = ((((aN / IAS_RR[10] - Gt[0][i]) / IAS_RR[11] - Gt[1][i]) / IAS_RR[12] - Gt[2][i]) / IAS_RR[13] - Gt[3][i]) / IAS_RR[14];
          const dl = Gt[4][i] - tmp; B[0][i] += dl * IAS_C[6]; B[1][i] += dl * IAS_C[7]; B[2][i] += dl * IAS_C[8]; B[3][i] += dl * IAS_C[9]; B[4][i] += dl;
        } else if (nn === 6) {
          const tmp = Gt[5][i]; Gt[5][i] = (((((aN / IAS_RR[15] - Gt[0][i]) / IAS_RR[16] - Gt[1][i]) / IAS_RR[17] - Gt[2][i]) / IAS_RR[18] - Gt[3][i]) / IAS_RR[19] - Gt[4][i]) / IAS_RR[20];
          const dl = Gt[5][i] - tmp; B[0][i] += dl * IAS_C[10]; B[1][i] += dl * IAS_C[11]; B[2][i] += dl * IAS_C[12]; B[3][i] += dl * IAS_C[13]; B[4][i] += dl * IAS_C[14]; B[5][i] += dl;
        } else {
          const tmp = Gt[6][i]; Gt[6][i] = ((((((aN / IAS_RR[21] - Gt[0][i]) / IAS_RR[22] - Gt[1][i]) / IAS_RR[23] - Gt[2][i]) / IAS_RR[24] - Gt[3][i]) / IAS_RR[25] - Gt[4][i]) / IAS_RR[26] - Gt[5][i]) / IAS_RR[27];
          const dl = Gt[6][i] - tmp;
          B[0][i] += dl * IAS_C[15]; B[1][i] += dl * IAS_C[16]; B[2][i] += dl * IAS_C[17];
          B[3][i] += dl * IAS_C[18]; B[4][i] += dl * IAS_C[19]; B[5][i] += dl * IAS_C[20]; B[6][i] += dl;
          const adl = Math.abs(dl);
          if (adl > adlMax) adlMax = adl;   /* v31：收敛残差改为循环末统一归一 */
        }
      }
    }
    /* v31：收敛判据 = max|Δb₆|/max|a(末内部点)|（REBOUND GLOBAL 收敛监控同式）。
     * 旧版用步首 a₀ 归一：速度相关力下末点力可显著偏离步首值，残差被错误放大/缩小。 */
    err = trialA > 1e-300 ? adlMax / trialA : 0;
  }
  /* ---- v31 自适应步长决策（REBOUND ias15.c「Find new timestep」块逐式移植）----
   * PRS23（默认，现行 REBOUND）或 GLOBAL（Rein-Spiegel 2015）估计局部误差 →
   * dt_new = (ε/err)^{1/7}·h（PRS23 形式见下）；欲缩 >4× → 整步拒绝回滚重做；
   * 欲增 >4× → 封顶 4×；min_dt 地板。fixed=true（epsilon=0 语义）时整段跳过。 */
  let dtNext = 4 * h;
  if (!fixed && iasEpsilon > 0) {
    let dtNew;
    if (IAS_ADAPTIVE_MODE === 0) {
      /* PRS23（Pham-Rein-Spiegel 2024）：a/jerk/snap/crackle 时标（b 系数组合，
       * y2..y5 逐式对齐 REBOUND；a0i≈0 的天体跳过）。数值因子 5040=7! 用于与
       * GLOBAL 判据在默认 ε 下对齐（REBOUND 原文注释）。 */
      let minTs2 = Infinity;
      for (let i = 0; i < N; i++) {
        let a0i = 0, y2 = 0, y3 = 0, y4 = 0, y5 = 0;
        for (let c = 0; c < 3; c++) {
          const k = 3 * i + c, a0k = iasA0[k];
          a0i += a0k * a0k;
          let t = a0k + B[0][k] + B[1][k] + B[2][k] + B[3][k] + B[4][k] + B[5][k] + B[6][k];
          y2 += t * t;
          t = B[0][k] + 2 * B[1][k] + 3 * B[2][k] + 4 * B[3][k] + 5 * B[4][k] + 6 * B[5][k] + 7 * B[6][k];
          y3 += t * t;
          t = 2 * B[1][k] + 6 * B[2][k] + 12 * B[3][k] + 20 * B[4][k] + 30 * B[5][k] + 42 * B[6][k];
          y4 += t * t;
          t = 6 * B[2][k] + 24 * B[3][k] + 60 * B[4][k] + 120 * B[5][k] + 210 * B[6][k];
          y5 += t * t;
        }
        if (!isFinite(a0i) || a0i === 0) continue;   /* 无力/坏值天体跳过（REBOUND 同） */
        const ts2 = 2 * y2 / (y3 + Math.sqrt(y4 * y2));
        if (isFinite(ts2) && ts2 > 0 && ts2 < minTs2) minTs2 = ts2;
      }
      dtNew = isFinite(minTs2) ? Math.sqrt(minTs2) * h * iasSqrt7(iasEpsilon * 5040) : 4 * h;
    } else {
      /* GLOBAL（Rein & Spiegel 2015）：err = max|b₆|/max|a(末内部点)|，
       * 慢变加速度滤除：v²h²/x² < 1e-16 的天体不计入（REBOUND 同）。 */
      let maxa = 0, maxj = 0;
      for (let i = 0; i < N; i++) {
        const v2t = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
        const x2t = px[i] * px[i] + py[i] * py[i] + pz[i] * pz[i];
        if (x2t > 0 && v2t * h * h / x2t < 1e-16) continue;
        const ak = Math.max(Math.abs(ax[i]), Math.abs(ay[i]), Math.abs(az[i]));
        const bk = Math.max(Math.abs(B[6][3 * i]), Math.abs(B[6][3 * i + 1]), Math.abs(B[6][3 * i + 2]));
        if (ak > maxa) maxa = ak;
        if (bk > maxj) maxj = bk;
      }
      const errG = (maxj > 0 && maxa > 0) ? maxj / maxa : 0;
      dtNew = (errG > 0 && isFinite(errG)) ? iasSqrt7(iasEpsilon / errG) * h : 4 * h;
    }
    if (!isFinite(dtNew) || dtNew <= 0) dtNew = 4 * h;   /* 误差估计失效 → 稳步增长（REBOUND 同） */
    if (dtNew < IAS_MIN_DT) dtNew = IAS_MIN_DT;          /* min_dt 地板（防 r→0 死锁） */
    if (dtNew < IAS_SAFETY * h) {
      /* ---- 步拒绝（REBOUND：恢复步首态 + 预测器按新步长从上接受步真值重排）---- */
      for (let i = 0; i < N; i++) {
        px[i] = iasX0[3 * i]; py[i] = iasX0[3 * i + 1]; pz[i] = iasX0[3 * i + 2];
        vx[i] = iasV0[3 * i]; vy[i] = iasV0[3 * i + 1]; vz[i] = iasV0[3 * i + 2];
      }
      for (let k = 0; k < 7; k++) { iasB[k].set(iasLastB[k].subarray(0, n3)); iasE[k].set(iasLastE[k].subarray(0, n3)); }
      if (iasLastDt > 0) iasPredictNextStep(dtNew / iasLastDt, n3, iasLastB, iasLastE, iasB, iasE);
      iasRejectCount++;
      if (refreshStats !== false) computeAccel(); else { minR2 = sR2; maxAccMag = sAM; minPairM = sPM; minPairV2 = sPV2; tideHeatW = sTH; }
      return { acc: false, dtNext: dtNew };
    }
    if (dtNew > 4 * h) dtNew = 4 * h;                    /* 增长上限（REBOUND safety_factor） */
    dtNext = dtNew;
  }
  /* ---- 提交（Kahan 补偿；x/v 终值 = Horner(1) 同式）---- */
  for (let i = 0; i < n3; i++) {
    const t1 = B[6][i] * (7 / 9) + B[5][i], t2 = t1 * (3 / 4) + B[4][i];
    const t3 = t2 * (5 / 7) + B[3][i], t4 = t3 * (2 / 3) + B[2][i];
    const t5 = t4 * (3 / 5) + B[1][i], t6 = t5 * (1 / 2) + B[0][i];
    const t7 = t6 * (1 / 3) + iasA0[i], t8 = t7 * h / 2 + iasV0[i];
    const xin = t8 * h;
    const u1 = B[6][i] * (7 / 8) + B[5][i], u2 = u1 * (6 / 7) + B[4][i];
    const u3 = u2 * (5 / 6) + B[3][i], u4 = u3 * (4 / 5) + B[2][i];
    const u5 = u4 * (3 / 4) + B[1][i], u6 = u5 * (2 / 3) + B[0][i];
    const u7 = u6 * (1 / 2) + iasA0[i];
    const vin = u7 * h;
    /* Kahan（REBOUND add_cs 等价：补偿量随步累积） */
    const xs = iasX0[i], xc = iasCSx[i];
    let t = xs + xin;
    if (Math.abs(xs) >= Math.abs(xin)) iasCSx[i] += (xs - t) + xin; else iasCSx[i] += (xin - t) + xs;
    iasX0[i] = t;
    const vs = iasV0[i], vc2 = iasCSv[i];
    t = vs + vin;
    if (Math.abs(vs) >= Math.abs(vin)) iasCSv[i] += (vs - t) + vin; else iasCSv[i] += (vin - t) + vs;
    iasV0[i] = t;
  }
  for (let i = 0; i < N; i++) {
    px[i] = iasX0[3 * i] + iasCSx[3 * i]; py[i] = iasX0[3 * i + 1] + iasCSx[3 * i + 1]; pz[i] = iasX0[3 * i + 2] + iasCSx[3 * i + 2];
    vx[i] = iasV0[3 * i] + iasCSv[3 * i]; vy[i] = iasV0[3 * i + 1] + iasCSv[3 * i + 1]; vz[i] = iasV0[3 * i + 2] + iasCSv[3 * i + 2];
  }
  iasCSx.fill(0, 0, n3); iasCSv.fill(0, 0, n3);   /* 提交后补偿清零（Python 验证要点） */
  /* 自旋：相位（梯形+Radau 加权 ζ）与轴向量（S⃗ += h·ΣWₙ N⃗ₙ） */
  if (spinPhase) {
    for (let i = 0; i < N; i++) {
      const zeta = spinAxAcc ? spinAxAcc[i] : 0;
      kahanAdd(spinPhase, cspinPhase, i, (spinRate[i] + 0.5 * zeta * h) * h);
      if (spinIx && bodyIA[i] > 0) {
        const Sx2 = bodyIA[i] * spinRate[i] * spinAxX[i] + spinIx[3 * i] * h;
        const Sy2 = bodyIA[i] * spinRate[i] * spinAxY[i] + spinIx[3 * i + 1] * h;
        const Sz2 = bodyIA[i] * spinRate[i] * spinAxZ[i] + spinIx[3 * i + 2] * h;
        const Sm = Math.sqrt(Sx2 * Sx2 + Sy2 * Sy2 + Sz2 * Sz2);
        if (Sm > 1e-300) {
          spinRate[i] = Sm / bodyIA[i];
          spinAxX[i] = Sx2 / Sm; spinAxY[i] = Sy2 / Sm; spinAxZ[i] = Sz2 / Sm;
        }
      }
    }
  }
  /* 账本入账（×h = Radau 加权时积分） */
  if (axRR) {
    sinkGWE[0] += ledRR * h; sinkTideE[0] += ledTL * h;
    sinkGWLx[0] += ledLRx * h; sinkGWLv[0] += ledLRy * h; sinkGWLz[0] += ledLRz * h;
    fieldPx[0] -= ledPx * h; fieldPv[0] -= ledPy * h; fieldPz[0] -= ledPz * h;
  }
  /* v31：保存「上接受步提交后真值」（预测器回滚源）并按 dtNext/h 预测下一步 b（Everhart）。
   * 固定步长（ratio=1）也要做——REBOUND 无条件执行，e 外推正是 IAS15 高阶来源之一。 */
  for (let k = 0; k < 7; k++) { iasLastB[k].set(iasB[k].subarray(0, n3)); iasLastE[k].set(iasE[k].subarray(0, n3)); }
  iasPredictNextStep(dtNext / h, n3, iasLastB, iasLastE, iasB, iasE);
  iasLastDt = h;
  /* 步尾统计刷新（与 Yoshida 契约一致：真实态力/统计供显示/GW 采样） */
  if (refreshStats !== false) computeAccel(); else { minR2 = sR2; maxAccMag = sAM; minPairM = sPM; minPairV2 = sPV2; tideHeatW = sTH; }
  return { acc: true, dtNext };
}

/* v31：固定步长单步（旧接口/测试兼容；预测器照常推进，等效 REBOUND epsilon=0） */
function stepIAS15(h, refreshStats) {
  const r = iasStepTry(h, refreshStats, true);
  return r.acc;
}
/* v31：自适应驱动（REBOUND 主循环 while(!step_try()) 的等价物）。
 * h 从 min(maxDt, 上步建议) 起步；拒绝则按收紧步长重试。必终止性：h ≤ 4·IAS_MIN_DT
 * 后 dtNew ≥ IAS_MIN_DT ≥ 0.25·h 恒成立 → 不再拒绝。返回实际推进的物理时步。 */
function stepIAS15Adaptive(maxDt) {
  let h = (iasDtNext > 0 && isFinite(iasDtNext) && iasDtNext < maxDt) ? iasDtNext : maxDt;
  for (let attempt = 0; attempt < 80; attempt++) {
    const r = iasStepTry(h, true, false);
    if (r.acc) { iasDtNext = r.dtNext; return h; }
    h = Math.max(r.dtNext, IAS_MIN_DT);
  }
  /* 80 次拒绝物理上不可达（见上终止性证明）；保险起见按当前 h 强制接受并计数 */
  iasRejectCount++;
  iasStepTry(h, true, true);
  iasDtNext = h;
  return h;
}

function stepYoshida4(h, refreshStats) {         /* S(w1·h) S(w0·h) S(w1·h)，Yoshida 1990
 * 速度无关力：经典漂-踢组合，严格四阶（快速路径，与 v6 前一致）。
 * 速度相关力（1PN/2PN/2.5PN/3.5PN/潮汐）：v19 起逐阶段「隐式中点」（见 stageMidpoint
 * 注释）——v6 的逐阶段 KDK 虽把 2.5PN 衰减率修到与 Peters 一致，但其 (x,v) 踢式
 * 分裂不可逆，1PN 保守部分仍 secular 泵能（强场 40 轨道 +2.5~5%）；中点法
 * 时间对称 → 能量有界。组合保持时间对称（三个对称子步的对称合成）。 */
  if (globalThis.__ENGINE__ && __ENGINE__.active) return __ENGINE__.stepYoshida4(h, refreshStats !== false);   /* v34: WASM 整步派发 */
  const a = YOSHIDA_W1 * h, b = YOSHIDA_W0 * h;
  if (!gr1pnOn && !gr25On && !gr2pnOn && !tideOn) {
    /* 速度无关力快速路径：经典漂-踢组合，3 次求力，严格四阶 */
    drift(a / 2); computeAccel(); kick(a);
    drift((a + b) / 2); computeAccel(); kick(b);
    drift((b + a) / 2); computeAccel(); kick(a);
    drift(a / 2);
    return true;   /* v31：漂-踢无迭代，恒收敛 */
  }
  stageMidpoint(a);
  stageMidpoint(b);
  stageMidpoint(a);
  if (refreshStats !== false) computeAccel();   // 步尾统计刷新（自适应步长用，与 v18 契约一致；v19f 可按需跳过）
  return mpConvLast;   /* v31：三阶段全部收敛才 true；false → 调用方折半重做整步 */
}

/* ---------------- v31 可逆自适应步长调度（Yoshida4 路径） ----------------
 * v30 及以前的问题（用户报告：PN 全开双黑洞近距能量/守恒量单调漂移、无法并合）：
 * 隐式中点映射本身时间对称（固定步长下能量误差有界，v19 Python 实测 6.7e-4），
 * 但变步长判据含「时间反演奇量」——minPairV2（v→−v 不变 ✓ 偶）之外，
 * maxAccMag 经 1PN 的 ṙ·v 项、spinAcc 经滞后力矩均含速度奇部分，且判据在
 * 「步首态」求值——反向积分时同一步会用不同步长 → 映射不再自逆 →
 * 每步注入 O(τ²) 单向误差 → 强场段 secular 泵能（v19f 的 γ⁴ 加密只是压低、
 * 没有消除该机制，代价还是并合末段步数爆炸）。
 * v31 依据 Hairer–Söderlind 2005（可逆变步长控制）：步长函数必须
 *   (a) 只含时间反演偶量（位置、v²、质量、自转态——自转态在 R 下不变）；
 *   (b) 在「步的中点态」隐式求值：h = H((z₀+z₁)/2)。
 * 由此步长对正向/反向积分逐位相同 → 映射严格自逆 → 保守系统能量误差恢复有界。
 * 判据集（全部偶量，牛顿极限下与 v30 行为同标度）：
 *   1) 动力学时标：dt ≤ η·√(r_eff³/GM_pair)（牛顿下 ≡ 旧判据 1 的 η√(r_eff/a_max)）；
 *   2) 位移判据：dt ≤ η·r_min/|v_rel|（|v_rel|² 反演偶 ✓；高速飞越仍被正确解析）；
 *   3) 自转判据（位置版）：潮汐力矩 |Ω̇| ≈ 3k₂GR⁵Δt·m′²(|Ω|+n)/(I·r⁶) →
 *      dt ≤ η_Ω/coef（|Ω|+n 因子相消，纯位置+自转态）；1.5PN 进动
 *      |Ω_pre| ≈ G·μ·L_eff/(c²r³) 以 |L|≈μr²·√(GM/r³) 位置化估计；
 *   4) 强场 PN（γ>3e-3）：dt ≤ 0.022·(GM/c³)（= 旧 η·dynT·γ^1.5，位置-only）；
 *   4b) 极强场加密（γ>0.03）：dt ≤ 0.037·(GM/c³)·(0.03/γ)⁴（位置-only，常数不变）。
 * 中点隐式方程用「预猜-校正」迭代求解（通常 0-1 次重做）：以 H(当前态) 预猜 h、
 * 积分整步、以 H((z₀+z₁)/2) 校正；|Δh/h|≤1e-6接受，≤3 次校正，未达则接受
 * 残差（对称性破缺被压到每步 ≤1e-6×单步误差，远低于舍入）。 */
function scanPairStats(P, V, out) {
if (globalThis.__ENGINE__ && __ENGINE__.active && ((P === _wP && V === _wV) || (P === _midP && V === _midV))) return __ENGINE__.scanStats(P === _midP, out);   /* v34: WASM 统计扫描派发 */
  const Px = P[0], Py = P[1], Pz = P[2], Vx = V[0], Vy = V[1], Vz = V[2];
  let minR2 = Infinity, minPairM = 0, minPairV2 = 0;
  let spinCoefMax = 0;    /* dt_spin = ADAPTIVE_ETA_SPIN / coef（对全部天体取最紧） */
  const tideAct = tideOn && spinRate && bodyIA && bodyRadA;
  const spinAct = gr15spinOn && spinRate && bodyIA;
  for (let i = 0; i < N; i++) {
    const xi = Px[i], yi = Py[i], zi = Pz[i], mi = massA[i];
    const ci = tideAct && bodyLagA[i] > 0 && bodyTideA0[i] > 0
      ? 3 * bodyTideA0[i] * bodyLagA[i] / Math.max(bodyIA[i], 1e-300) : 0;
    for (let j = i + 1; j < N; j++) {
      const dx = Px[j] - xi, dy = Py[j] - yi, dz = Pz[j] - zi;
      const r2raw = dx * dx + dy * dy + dz * dz;
      const dvx = Vx[j] - Vx[i], dvy = Vy[j] - Vy[i], dvz = Vz[j] - Vz[i];
      const v2r = dvx * dvx + dvy * dvy + dvz * dvz;
      if (r2raw < minR2) { minR2 = r2raw; minPairM = mi + massA[j]; minPairV2 = v2r; }
      const mj = massA[j], Mp = mi + mj;
      /* 潮汐自转判据（位置版，接触内不施力 → 同口径跳过） */
      if (ci > 0 && r2raw > bodyRadA[i] * bodyRadA[i]) {
        const c = ci * mj * mj / (r2raw * r2raw * r2raw);   /* |Ω̇|/(|Ω|+n)，单位 1/s */
        if (c > spinCoefMax) spinCoefMax = c;
      }
      if (tideAct && bodyLagA[j] > 0 && bodyTideA0[j] > 0 && r2raw > bodyRadA[j] * bodyRadA[j]) {
        const c = 3 * bodyTideA0[j] * bodyLagA[j] * mi * mi
          / (Math.max(bodyIA[j], 1e-300) * r2raw * r2raw * r2raw);
        if (c > spinCoefMax) spinCoefMax = c;
      }
      /* 1.5PN 自旋进动判据（位置版）：|Ω_pre| ≈ (G/c²r³)·(2+3m′/2m)·|L|，
       * |L| ≈ μ·r²·√(GM/r³)（|L| 用速度信息则破坏偶性；圆/偏心轨道该估计
       * 偏保守近星点值，方向正确）。自转轴每步方向变化 ≤ η_Ω rad。 */
      if (spinAct && (spinRate[i] > 1e-300 || spinRate[j] > 1e-300) && Mp > 0) {
        const muP = mi * mj / Mp;
        const nDyn = Math.sqrt(G * Mp / (r2raw * Math.sqrt(r2raw)));
        const OmPreI = G / (C_SQ * r2raw * Math.sqrt(r2raw)) * (2 + 1.5 * mj / mi) * muP * r2raw * nDyn;
        const OmPreJ = G / (C_SQ * r2raw * Math.sqrt(r2raw)) * (2 + 1.5 * mi / mj) * muP * r2raw * nDyn;
        const cPre = spinRate[i] > 1e-300 ? OmPreI : 0;
        const cPreJ = spinRate[j] > 1e-300 ? OmPreJ : 0;
        const cM = Math.max(cPre, cPreJ);
        if (cM > spinCoefMax) spinCoefMax = cM;
      }
    }
  }
  out.minR2 = minR2; out.minPairM = minPairM; out.minPairV2 = minPairV2; out.spinCoef = spinCoefMax;
}
/* 调度求值：给定状态统计 → dt（只含偶判据；baseDt 封顶 + 地板）。 */
function calcAdaptiveDt(baseDt, st) {
  if (N < 2 || !st || st.minR2 === Infinity) return baseDt;
  /* 软化项以实际最近距离为上限：行星尺度保持原版行为，致密系统不被软化项淹没 */
  const soft2 = Math.min(ADAPTIVE_SOFT_SQ, st.minR2);
  const minR = Math.sqrt(st.minR2);
  const minReff = Math.sqrt(st.minR2 + soft2);
  const dynT = Math.sqrt(minReff * minReff * minReff / (G * Math.max(st.minPairM, 1e-30)));
  let dtCand = ADAPTIVE_ETA * dynT;                        /* 判据 1（位置-only） */
  /* 判据 2：最近对位移 —— 每步相对位移不超过 η·r（|v_rel|² 反演偶；圆轨道退化为判据 1） */
  if (st.minPairV2 > 1e-24) {
    const dtMove = ADAPTIVE_ETA * minR / Math.sqrt(st.minPairV2);
    if (dtMove < dtCand) dtCand = dtMove;
  }
  /* 判据 3：自转/进动（位置版系数，见 scanPairStats） */
  if (st.spinCoef > 1e-300) {
    const dtSpin = ADAPTIVE_ETA_SPIN / st.spinCoef;
    if (dtSpin < dtCand) dtCand = dtSpin;
  }
  const minDt = Math.max(1e-7, 1e-5 * dynT);
  let dt = Math.min(baseDt, Math.max(minDt, dtCand));
  /* 强场 PN 判据 4/4b（v6/v19f 常数不变；γ、GM/c³ 均位置-only）。
   * 完整物理依据见旧版注释：dt=GM/c³·0.022 捕获 ≥93% 衰减信号；γ⁴ 加密对齐
   * 实测泵能矩阵 —— v31 起调度本身可逆，泵能机制已除，加密律仅作分辨率保守余量。 */
  if (gr1pnOn && gr25On && st.minR2 > 0) {
    const gamma = G * st.minPairM / (minR * C_SQ);
    if (gamma > 3e-3) {
      const dtPN = PN_DT_ETA * dynT * Math.pow(gamma, 1.5);
      if (dtPN < dt) dt = Math.max(dtPN, minDt);
      if (gamma > PN_GAMMA_DEEP) {
        const dtDeep = PN_DEEP_ETA * (G * st.minPairM / (C_SQ * C_LIGHT)) * Math.pow(PN_GAMMA_DEEP / gamma, PN_DEEP_EXP);
        if (dtDeep < dt) dt = Math.max(dtDeep, Math.min(minDt, Math.max(dtDeep * 0.5, 1e-13)));
      }
    }
  }
  /* 最终以 baseDt 封顶：用户设定始终是最大步长（防远距 dt 膨胀瞬移） */
  return Math.min(baseDt, dt);
}
/* v31：可逆自适应单步（Yoshida4）——中点隐式步长的预猜-校正驱动。
 * 返回实际推进的物理时步 h（步首态 → 步末态；账本/自转随步内一致演化）。
 * 重做时整步回滚（含 Kahan 补偿、账本、自转相位/轴向），不会重复入账。 */
let _stA = null, _stB = null;   /* 统计 scratch（惰性初始化，避免每步分配） */
let _midWrapVer = -1;
const _midP = [null, null, null], _midV = [null, null, null];
let ySnapCap = 0;
let ySnapPx = null, ySnapPy = null, ySnapPz = null, ySnapVx = null, ySnapVy = null, ySnapVz = null;
let ySnapCpx = null, ySnapCpy = null, ySnapCpz = null, ySnapCvx = null, ySnapCvy = null, ySnapCvz = null;
let ySpinRate = null, ySpinPhase = null, yCspinPhase = null, ySpinAxX = null, ySpinAxY = null, ySpinAxZ = null;
let yLedSnap = new Float64Array(8);
function ensureYoshidaSnap() {
  if (ySnapCap >= CAP) return;
  ySnapPx = new Float64Array(CAP); ySnapPy = new Float64Array(CAP); ySnapPz = new Float64Array(CAP);
  ySnapVx = new Float64Array(CAP); ySnapVy = new Float64Array(CAP); ySnapVz = new Float64Array(CAP);
  ySnapCpx = new Float64Array(CAP); ySnapCpy = new Float64Array(CAP); ySnapCpz = new Float64Array(CAP);
  ySnapCvx = new Float64Array(CAP); ySnapCvy = new Float64Array(CAP); ySnapCvz = new Float64Array(CAP);
  ySpinRate = new Float64Array(CAP); ySpinPhase = new Float64Array(CAP); yCspinPhase = new Float64Array(CAP);
  ySpinAxX = new Float64Array(CAP); ySpinAxY = new Float64Array(CAP); ySpinAxZ = new Float64Array(CAP);
  ySnapCap = CAP;
}
function yoshidaSnapSave() {
  ensureYoshidaSnap();
  for (let i = 0; i < N; i++) {
    ySnapPx[i] = px[i]; ySnapPy[i] = py[i]; ySnapPz[i] = pz[i];
    ySnapVx[i] = vx[i]; ySnapVy[i] = vy[i]; ySnapVz[i] = vz[i];
    ySnapCpx[i] = cpx[i]; ySnapCpy[i] = cpy[i]; ySnapCpz[i] = cpz[i];
    ySnapCvx[i] = cvx[i]; ySnapCvy[i] = cvy[i]; ySnapCvz[i] = cvz[i];
    ySpinRate[i] = spinRate[i]; ySpinPhase[i] = spinPhase[i]; yCspinPhase[i] = cspinPhase[i];
    ySpinAxX[i] = spinAxX[i]; ySpinAxY[i] = spinAxY[i]; ySpinAxZ[i] = spinAxZ[i];
  }
  yLedSnap[0] = sinkGWE[0]; yLedSnap[1] = sinkTideE[0];
  yLedSnap[2] = sinkGWLx[0]; yLedSnap[3] = sinkGWLv[0]; yLedSnap[4] = sinkGWLz[0];
  yLedSnap[5] = fieldPx[0]; yLedSnap[6] = fieldPv[0]; yLedSnap[7] = fieldPz[0];
}
function yoshidaSnapRestore() {
  for (let i = 0; i < N; i++) {
    px[i] = ySnapPx[i]; py[i] = ySnapPy[i]; pz[i] = ySnapPz[i];
    vx[i] = ySnapVx[i]; vy[i] = ySnapVy[i]; vz[i] = ySnapVz[i];
    cpx[i] = ySnapCpx[i]; cpy[i] = ySnapCpy[i]; cpz[i] = ySnapCpz[i];
    cvx[i] = ySnapCvx[i]; cvy[i] = ySnapCvy[i]; cvz[i] = ySnapCvz[i];
    spinRate[i] = ySpinRate[i]; spinPhase[i] = ySpinPhase[i]; cspinPhase[i] = yCspinPhase[i];
    spinAxX[i] = ySpinAxX[i]; spinAxY[i] = ySpinAxY[i]; spinAxZ[i] = ySpinAxZ[i];
  }
  sinkGWE[0] = yLedSnap[0]; sinkTideE[0] = yLedSnap[1];
  sinkGWLx[0] = yLedSnap[2]; sinkGWLv[0] = yLedSnap[3]; sinkGWLz[0] = yLedSnap[4];
  fieldPx[0] = yLedSnap[5]; fieldPv[0] = yLedSnap[6]; fieldPz[0] = yLedSnap[7];
}
const ADAPT_MID_TOL = 1e-6;    /* 中点步长方程容差（相对） */
const ADAPT_MID_MAX = 3;       /* 校正迭代上限（重做 ≤3 次） */
let adaptRedoLast = 0, adaptHalfLast = 0;   /* 诊断：最近一步的校正/折半次数 */
function advanceAdaptiveYoshida(baseDt) {
  if (N === 0) return 0;
  if (N < 2) { stepYoshida4(Math.min(baseDt, 1), true); return Math.min(baseDt, 1); }
  if (!_stA) { _stA = { minR2: 0, minPairM: 0, minPairV2: 0, spinCoef: 0 }; _stB = { minR2: 0, minPairM: 0, minPairV2: 0, spinCoef: 0 }; }
  yoshidaSnapSave();
  if (_midWrapVer !== bufVer) {
    _midP[0] = mpPx; _midP[1] = mpPy; _midP[2] = mpPz;
    _midV[0] = mpVx; _midV[1] = mpVy; _midV[2] = mpVz;
    _midWrapVer = bufVer;
  }
  scanPairStats(_wP, _wV, _stA);
  let h = calcAdaptiveDt(baseDt, _stA);
  let halfs = 0;
  for (let outer = 0; outer < 6; outer++) {
    if (outer > 0) yoshidaSnapRestore();
    const ok = stepYoshida4(h, true);
    if (!ok) {
      /* 中点固定点未收敛（dt 过大）→ 折半重做整步（账本/自转已回滚） */
      halfs++;
      h = Math.max(1e-13, h * 0.5);
      continue;
    }
    /* 中点态 = (z₀+z₁)/2 → 重求 H，检查步长方程 h = H(中点) 的自洽性 */
    for (let i = 0; i < N; i++) {
      mpPx[i] = (px[i] + ySnapPx[i]) / 2; mpPy[i] = (py[i] + ySnapPy[i]) / 2; mpPz[i] = (pz[i] + ySnapPz[i]) / 2;
      mpVx[i] = (vx[i] + ySnapVx[i]) / 2; mpVy[i] = (vy[i] + ySnapVy[i]) / 2; mpVz[i] = (vz[i] + ySnapVz[i]) / 2;
    }
    scanPairStats(_midP, _midV, _stB);
    const hMid = calcAdaptiveDt(baseDt, _stB);
    if (Math.abs(hMid / h - 1) <= ADAPT_MID_TOL) { adaptRedoLast = outer; adaptHalfLast = halfs; return h; }
    h = hMid;
  }
  /* 校正迭代达上限：接受残差（|Δh/h| > 1e-6 的重做连续 3 次以上不收缩才到达，
   * 正常演化不会发生；残差级对称性破缺 ≤ 单步误差 × 容差，仍远低于舍入噪声） */
  adaptRedoLast = ADAPT_MID_MAX; adaptHalfLast = halfs;
  return h;
}


/* ===== 物理核区块 HTML L3630-L3654（原样） ===== */

/* 每天体潮汐缓存刷新（initState / 合并后调用）：R, k2, Δt, I, k2·G·R⁵, 自转轴
 * v33：自转轴改为「已演化则保留（归一化防漂移），未初始化（NaN/零向量）才从
 * spin_tilt_deg 建轴」。旧行为在每次并合后把全系统所有天体的轴重置回初值
 * （方位角还被 acos 丢掉）—— 长期运行 + 并合场景下轴信息被静默清除；
 * initState 现以 NaN 显式标记「需要重建」（表单改倾角/重置/导入均经 initState）。 */
function refreshBodyTideCache() {
  for (let i = 0; i < N; i++) {
    const R = meta[i].radius > 0 ? meta[i].radius : massRadius(massA[i]);
    bodyRadA[i] = R;
    /* v7：k2/Δt 留空时按质量+半径自动推算（结构参数合一） */
    bodyK2A[i] = bodyK2Auto[i] ? autoK2(massA[i], R) : meta[i].tideK2;
    bodyLagA[i] = bodyLagAuto[i] ? autoTideLag(massA[i], R) : (meta[i].tideLag || 0);
    bodyIA[i] = TIDE_GYRATION * massA[i] * R * R;
    bodyTideA0[i] = bodyK2A[i] * G * R * R * R * R * R;
    bodyTideA03[i] = bodyK2A[i] * TIDE_K3_RATIO * G * R * R * R * R * R * R * R;   /* v19e：k3·G·R⁷ */
    const axn2 = spinAxX[i] * spinAxX[i] + spinAxY[i] * spinAxY[i] + spinAxZ[i] * spinAxZ[i];
    if (isFinite(axn2) && axn2 > 0.5) {
      const il = 1 / Math.sqrt(axn2);            /* 演化轴：归一化保留（spinVecUpdate 每步已归一） */
      spinAxX[i] *= il; spinAxY[i] *= il; spinAxZ[i] *= il;
    } else {
      const tilt = meta[i].spinTiltRad || 0;     /* 未初始化/退化：从输入倾角建轴（方位角 0，同旧约定） */
      spinAxX[i] = 0; spinAxY[i] = -Math.sin(tilt); spinAxZ[i] = Math.cos(tilt);
    }
  }
}


/* ===== 物理核区块 HTML L4197-L4291（原样） ===== */

/* ---------------- 守恒量（牛顿 + 1PN/2PN 框架，物理账本） ----------------
 * v7：粒子系统能量含 IW95 精确 1PN/2PN 两体修正（成对近似，与动力学同阶）+
 * 自转动能 + 保守潮汐势；潮汐热与 GW 辐射（2.5PN/3.5PN 力做功）以账本累计，
 * 核算后 ΔE = (E−E₀) + 已耗散 ≈ 积分器误差级 —— 恢复物理性。 */
/* v25：能量分项 scratch（computeTotalEnergy 每次顺带记录，无头快照 K/U 拆分用，
 * 零额外遍历零分配；只读，勿在别处当可变量依赖） */
let _eKe = 0, _ePe = 0, _eEp = 0;
/* v31：规范不变 E(x) 能量平衡的参考初值（强场面板用；initState/回退时置 null） */
let gaugeInvE0 = null;
function computeTotalEnergy() {
  let KE = 0, PE = 0, EP = 0;
  const pn1 = gr1pnOn, pn2 = gr2pnOn && gr1pnOn;
  for (let i = 0; i < N; i++) {
    const v2 = vx[i] * vx[i] + vy[i] * vy[i] + vz[i] * vz[i];
    KE += 0.5 * massA[i] * v2;
    if ((tideOn || j2On) && spinRate) KE += 0.5 * bodyIA[i] * spinRate[i] * spinRate[i];
    for (let j = i + 1; j < N; j++) {
      const dx = px[j] - px[i], dy = py[j] - py[i], dz = pz[j] - pz[i];
      const r = Math.sqrt(dx * dx + dy * dy + dz * dz + GRAV_SOFTENING_SQ);
      if (pwOn) {
        /* v35：PW 伪牛顿势（与 accumulateAccel 的成对替换严格同式/同下限/r_g） */
        const rgPW = 2 * G * (massA[i] + massA[j]) / C_SQ;
        const denPW = Math.max(r - rgPW, 0.05 * rgPW);
        PE -= G * massA[i] * massA[j] / denPW;
      } else {
        PE -= G * massA[i] * massA[j] / r;
      }
      if (tideOn) {
        const invR6 = 1 / (r * r * r * r * r * r);
        if (bodyTideA0[i] > 0) PE -= bodyTideA0[i] * massA[j] * massA[j] * invR6;
        if (bodyTideA0[j] > 0) PE -= bodyTideA0[j] * massA[i] * massA[i] * invR6;
        /* v19e：八极潮势能 U₃ = −k₃Gm′²R⁷/r⁸（与 accumulateAccel 的 F₃ ∝ r⁻⁹ 配套） */
        if (bodyTideA03 && bodyTideA03[i] > 0) PE -= bodyTideA03[i] * massA[j] * massA[j] * invR6 / (r * r);
        if (bodyTideA03 && bodyTideA03[j] > 0) PE -= bodyTideA03[j] * massA[i] * massA[i] * invR6 / (r * r);
      }
      if (j2On) {
        /* v35：J2 旋转扁体势能（符号修正 + 独立于 tideOn）：
         * U_J2 = +G m_i m_j J2 R²(3(ŝ·n̂)²−1)/(2r³)（与修正后 accumulateAccel 的
         * J2 力/力矩同源——能量账本闭合；v34 旧式符号相反，已翻转） */
        const invR3 = 1 / (r * r * r);
        const nxJ = dx / r, nyJ = dy / r, nzJ = dz / r;
        if (bodyK2A[i] > 0 && spinRate && spinRate[i] > 0) {
          const Ri2 = bodyRadA[i];
          if (r * r > Ri2 * Ri2) {
            const J2i = 2 / 3 * bodyK2A[i] * spinRate[i] * spinRate[i] * Ri2 * Ri2 * Ri2 / (G * massA[i]);
            const cI2 = spinAxX[i] * nxJ + spinAxY[i] * nyJ + spinAxZ[i] * nzJ;
            PE += 0.5 * G * massA[i] * massA[j] * J2i * Ri2 * Ri2 * (3 * cI2 * cI2 - 1) * invR3;
          }
        }
        if (bodyK2A[j] > 0 && spinRate && spinRate[j] > 0) {
          const Rj2 = bodyRadA[j];
          if (r * r > Rj2 * Rj2) {
            const J2j = 2 / 3 * bodyK2A[j] * spinRate[j] * spinRate[j] * Rj2 * Rj2 * Rj2 / (G * massA[j]);
            const cJ2 = spinAxX[j] * nxJ + spinAxY[j] * nyJ + spinAxZ[j] * nzJ;
            PE += 0.5 * G * massA[i] * massA[j] * J2j * Rj2 * Rj2 * (3 * cJ2 * cJ2 - 1) * invR3;
          }
        }
      }
      if (gr15spinOn && spinRate && bodyIA && r > 0) {
        /* v21 Kidder H_SO + H_SS（成对，与 accumulateAccel 的 1.5PN 块同式同约定）：
         * H_SO = G/(c²r³)·L_N·[(2+3m_j/2m_i)S_i + (2+3m_i/2m_j)S_j]
         * H_SS = −G/(c²r³)·[3(n̂·S_i)(n̂·S_j) − S_i·S_j] */
        const dvx = vx[j] - vx[i], dvy = vy[j] - vy[i], dvz = vz[j] - vz[i];
        const mi2 = massA[i], mj2 = massA[j], Mp = mi2 + mj2, muP = mi2 * mj2 / Mp;
        const nx = dx / r, ny = dy / r, nz = dz / r;
        const SIx = bodyIA[i] * spinRate[i] * spinAxX[i], SIy = bodyIA[i] * spinRate[i] * spinAxY[i], SIz = bodyIA[i] * spinRate[i] * spinAxZ[i];
        const SJx = bodyIA[j] * spinRate[j] * spinAxX[j], SJy = bodyIA[j] * spinRate[j] * spinAxY[j], SJz = bodyIA[j] * spinRate[j] * spinAxZ[j];
        const LNx = muP * (dy * dvz - dz * dvy), LNy = muP * (dz * dvx - dx * dvz), LNz = muP * (dx * dvy - dy * dvx);
        const c1 = 2 + 1.5 * mj2 / mi2, c2 = 2 + 1.5 * mi2 / mj2;
        const Sx = c1 * SIx + c2 * SJx, Sy = c1 * SIy + c2 * SJy, Sz = c1 * SIz + c2 * SJz;
        const nS1 = nx * SIx + ny * SIy + nz * SIz, nS2 = nx * SJx + ny * SJy + nz * SJz;
        const kkE = G / (C_SQ * r * r * r);
        EP += kkE * (LNx * Sx + LNy * Sy + LNz * Sz) - kkE * (3 * nS1 * nS2 - (SIx * SJx + SIy * SJy + SIz * SJz));
      }
      if (pn1 || pn2) {
        /* IW95 E_PN/E_2PN（成对近似，相对量）：dv = v_j−v_i */
        const dvx = vx[j] - vx[i], dvy = vy[j] - vy[i], dvz = vz[j] - vz[i];
        const v2rel = dvx * dvx + dvy * dvy + dvz * dvz;
        const nx = dx / r, ny = dy / r, nz = dz / r;   // v10 修复：ny 曾误用速度差分量 dvy → 1PN/2PN 能量账本 rd 失真
        const rd = dvx * nx + dvy * ny + dvz * nz;
        const mi = massA[i], mj = massA[j], M = mi + mj;
        const nu = mi * mj / (M * M);
        const mu = mi * mj / M;
        const Gm = G * M;
        if (pn1) {
          EP += mu / C_SQ * (3 / 8 * (1 - 3 * nu) * v2rel * v2rel
            + 0.5 * Gm / r * ((3 + nu) * v2rel + nu * rd * rd)
            + 0.5 * Gm * Gm / (r * r));
        }
        if (pn2) {
          EP += mu / (C_SQ * C_SQ) * (
            5 / 16 * (1 - 7 * nu + 13 * nu * nu) * v2rel * v2rel * v2rel
            + 1 / 8 * (21 - 23 * nu - 27 * nu * nu) * Gm / r * v2rel * v2rel
            + 1 / 4 * nu * (1 - 15 * nu) * Gm / r * v2rel * rd * rd
            - 3 / 8 * nu * (1 - 3 * nu) * Gm / r * rd * rd * rd * rd
            - 1 / 4 * (2 + 15 * nu) * Gm * Gm * Gm / (r * r * r)
            + 1 / 8 * (14 - 55 * nu + 4 * nu * nu) * Gm * Gm / (r * r) * v2rel
            + 1 / 8 * (4 + 69 * nu + 12 * nu * nu) * Gm * Gm / (r * r) * rd * rd);
        }
      }
    }
  }
  _eKe = KE; _ePe = PE; _eEp = EP;
  return KE + PE + EP;
}


/* ===== 物理核区块 HTML L4364-L4383（原样） ===== */

function computeTotalMomentum() {
  let Px = 0, Py = 0, Pz = 0;
  for (let i = 0; i < N; i++) { Px += massA[i] * vx[i]; Py += massA[i] * vy[i]; Pz += massA[i] * vz[i]; }
  return [Px + fieldPx[0], Py + fieldPv[0], Pz + fieldPz[0]];
}
/* v7：总角动量（轨道+自转）与核算后总角动量（计入 GW 辐射账本）*/
function computeTotalAngular() {
  let Lx = 0, Lv = 0, Lz = 0;
  for (let i = 0; i < N; i++) {
    Lx += massA[i] * (py[i] * vz[i] - pz[i] * vy[i]);
    Lv += massA[i] * (pz[i] * vx[i] - px[i] * vz[i]);
    Lz += massA[i] * (px[i] * vy[i] - py[i] * vx[i]);
    if ((tideOn || j2On) && spinRate && bodyIA) {
      Lx += bodyIA[i] * spinRate[i] * spinAxX[i];
      Lv += bodyIA[i] * spinRate[i] * spinAxY[i];
      Lz += bodyIA[i] * spinRate[i] * spinAxZ[i];
    }
  }
  return [Lx, Lv, Lz];
}


/* ===== v34 补充声明（原 HTML L6758；随帧统计外置至此，主线程与 worker 共用绑定） ===== */
let lastAdaptSteps = 0, lastAdaptAdvanced = 0;

/* ===== v35：引力波应变核心采样（主线程与 physics-worker 共用） =====
 * 质量四极矩二阶导由状态矢量解析求出（仅依赖状态数组/常量，worker 可用）：
 *   Q̈_ij = Σ m( x_i a_j + x_j a_i + 2v_i v_j − (2/3)δ_ij (v² + x⃗·a⃗) )
 * 观测者沿 +z（TT 规约）：h₊ = G(Q̈xx − Q̈yy)/(c⁴D)，h× = 2G·Q̈xy/(c⁴D)。
 * 返回 [h₊, h×]。多线程模式下 worker 按与 physicsAdvance 相同的节奏采样本函数，
 * 结果随帧消息回传主线程拼接波形（修复 v34「MT 开启后引力波绘制/观测失效」）。
 * f_GW/并合倒计时等读数量依赖 meta/massRadius，仍由主线程 computeGWStrain 计算。 */
function computeGWStrainCore() {
  let Qxx = 0, Qyy = 0, Qxy = 0;
  for (let i = 0; i < N; i++) {
    const xi = px[i], yi = py[i], zi = pz[i];
    const vxi = vx[i], vyi = vy[i], vzi = vz[i];
    const axi = ax[i], ayi = ay[i], azi = az[i];
    const v2 = vxi * vxi + vyi * vyi + vzi * vzi;
    const v2xa = v2 + xi * axi + yi * ayi + zi * azi;
    const mi = massA[i];
    Qxx += mi * (2 * xi * axi + 2 * vxi * vxi - v2xa / 3);
    Qyy += mi * (2 * yi * ayi + 2 * vyi * vyi - v2xa / 3);
    Qxy += mi * (xi * ayi + yi * axi + 2 * vxi * vyi);
  }
  const D = GW_DIST_MPC * 3.0856775814913673e22;
  const c4D = C_SQ * C_SQ * D;
  return [G * (Qxx - Qyy) / c4D, 2 * G * Qxy / c4D];
}


/* ===== v34 导出桥（只读引用聚合；不改动上方任何物理代码） ===== */
globalThis.__NBODY_CORE__ = {
  refs: () => ({
    G, C_SQ, C_LIGHT, C_5, AU, DAY_SEC, YEAR_SEC, CENTURY_SEC,
    GRAV_SOFTENING_SQ, ADAPTIVE_ETA, ADAPTIVE_ETA_SPIN, ADAPTIVE_SOFT_SQ,
    TIDE_GYRATION, TIDE_LAG_MAX, TIDE_K2_DEFAULT, TIDE_K3_RATIO,
    PN_TIDE_R_MIN, PN_DT_ETA, PN_GAMMA_DEEP, PN_DEEP_EXP, PN_DEEP_ETA,
    YOSHIDA_W1, YOSHIDA_W0, IAS_H, IAS_RR, IAS_C, IAS_D, IAS_W,
    IAS_EPS, IAS_ADAPTIVE_MODE, IAS_SAFETY, IAS_MIN_DT,
    MID_MAX_ITER, IAS_ITER_MAX,
    get N(){return N;}, set N(v){N=v;},
    get CAP(){return CAP;}, set CAP(v){CAP=v;},
    get bufVer(){return bufVer;}, set bufVer(v){bufVer=v;},
    get integrator(){return integrator;}, set integrator(v){integrator=v;},
    get gr1pnOn(){return gr1pnOn;}, set gr1pnOn(v){gr1pnOn=v;},
    get gr25On(){return gr25On;}, set gr25On(v){gr25On=v;},
    get gr2pnOn(){return gr2pnOn;}, set gr2pnOn(v){gr2pnOn=v;},
    get gr35On(){return gr35On;}, set gr35On(v){gr35On=v;},
    get gr15spinOn(){return gr15spinOn;}, set gr15spinOn(v){gr15spinOn=v;},
    get tideOn(){return tideOn;}, set tideOn(v){tideOn=v;},
    get j2On(){return j2On;}, set j2On(v){j2On=v;},
    get pwOn(){return pwOn;}, set pwOn(v){pwOn=v;},
    get iasEpsilon(){return iasEpsilon;}, set iasEpsilon(v){iasEpsilon=v;},
    get iasDtNext(){return iasDtNext;}, set iasDtNext(v){iasDtNext=v;},
    get iasRejectCount(){return iasRejectCount;}, set iasRejectCount(v){iasRejectCount=v;},
    get iasReady(){return iasReady;}, set iasReady(v){iasReady=v;},
    get iasN3(){return iasN3;}, set iasN3(v){iasN3=v;},
    get iasLastDt(){return iasLastDt;}, set iasLastDt(v){iasLastDt=v;},
    get minR2(){return minR2;}, set minR2(v){minR2=v;},
    get maxAccMag(){return maxAccMag;}, set maxAccMag(v){maxAccMag=v;},
    get minPairM(){return minPairM;}, set minPairM(v){minPairM=v;},
    get minPairV2(){return minPairV2;}, set minPairV2(v){minPairV2=v;},
    get tideHeatW(){return tideHeatW;}, set tideHeatW(v){tideHeatW=v;},
    get mpIterLast(){return mpIterLast;}, set mpIterLast(v){mpIterLast=v;},
    get mpConvLast(){return mpConvLast;}, set mpConvLast(v){mpConvLast=v;},
    get adaptRedoLast(){return adaptRedoLast;}, set adaptRedoLast(v){adaptRedoLast=v;},
    get adaptHalfLast(){return adaptHalfLast;}, set adaptHalfLast(v){adaptHalfLast=v;},
    get lastAdaptSteps(){return lastAdaptSteps;}, set lastAdaptSteps(v){lastAdaptSteps=v;},
    get lastAdaptAdvanced(){return lastAdaptAdvanced;}, set lastAdaptAdvanced(v){lastAdaptAdvanced=v;},
    get playing(){return playing;}, set playing(v){playing=v;},
    get meta(){return meta;}, set meta(v){meta=v;},
    arrs: () => ({ px, py, pz, vx, vy, vz, ax, ay, az, massA,
      cpx, cpy, cpz, cvx, cvy, cvz,
      spinRate, spinAcc, spinTx, spinTy, spinTz, spinPhase, cspinPhase,
      spinAxX, spinAxY, spinAxZ,
      bodyRadA, bodyK2A, bodyLagA, bodyIA, bodyTideA0, bodyTideA03,
      bodyK2Auto, bodyLagAuto,
      axRR, ayRR, azRR, axTL, ayTL, azTL,
      mpPx, mpPy, mpPz, mpVx, mpVy, mpVz, mpAx, mpAy, mpAz,
      mpRX, mpRY, mpRZ, mpTX, mpTY, mpTZ,
      mpPnX, mpPnY, mpPnZ, mpVnX, mpVnY, mpVnZ, mpSpin,
      ySnapPx, ySnapPy, ySnapPz, ySnapVx, ySnapVy, ySnapVz,
      ySnapCpx, ySnapCpy, ySnapCpz, ySnapCvx, ySnapCvy, ySnapCvz,
      ySpinRate, ySpinPhase, yCspinPhase, ySpinAxX, ySpinAxY, ySpinAxZ }),
    ledgers: () => ({ sinkTideE, sinkGWE, sinkGWLx, sinkGWLv, sinkGWLz, fieldPx, fieldPv, fieldPz }),
    setArrs(a) {
      px=a.px; py=a.py; pz=a.pz; vx=a.vx; vy=a.vy; vz=a.vz; ax=a.ax; ay=a.ay; az=a.az; massA=a.massA;
      cpx=a.cpx; cpy=a.cpy; cpz=a.cpz; cvx=a.cvx; cvy=a.cvy; cvz=a.cvz;
      spinRate=a.spinRate; spinAcc=a.spinAcc; spinTx=a.spinTx; spinTy=a.spinTy; spinTz=a.spinTz;
      spinPhase=a.spinPhase; cspinPhase=a.cspinPhase;
      spinAxX=a.spinAxX; spinAxY=a.spinAxY; spinAxZ=a.spinAxZ;
      bodyRadA=a.bodyRadA; bodyK2A=a.bodyK2A; bodyLagA=a.bodyLagA; bodyIA=a.bodyIA;
      bodyTideA0=a.bodyTideA0; bodyTideA03=a.bodyTideA03;
      bodyK2Auto=a.bodyK2Auto; bodyLagAuto=a.bodyLagAuto;
      axRR=a.axRR; ayRR=a.ayRR; azRR=a.azRR; axTL=a.axTL; ayTL=a.ayTL; azTL=a.azTL;
      mpPx=a.mpPx; mpPy=a.mpPy; mpPz=a.mpPz; mpVx=a.mpVx; mpVy=a.mpVy; mpVz=a.mpVz;
      mpAx=a.mpAx; mpAy=a.mpAy; mpAz=a.mpAz;
      mpRX=a.mpRX; mpRY=a.mpRY; mpRZ=a.mpRZ; mpTX=a.mpTX; mpTY=a.mpTY; mpTZ=a.mpTZ;
      mpPnX=a.mpPnX; mpPnY=a.mpPnY; mpPnZ=a.mpPnZ; mpVnX=a.mpVnX; mpVnY=a.mpVnY; mpVnZ=a.mpVnZ;
      mpSpin=a.mpSpin;
      ySnapPx=a.ySnapPx; ySnapPy=a.ySnapPy; ySnapPz=a.ySnapPz;
      ySnapVx=a.ySnapVx; ySnapVy=a.ySnapVy; ySnapVz=a.ySnapVz;
      ySnapCpx=a.ySnapCpx; ySnapCpy=a.ySnapCpy; ySnapCpz=a.ySnapCpz;
      ySnapCvx=a.ySnapCvx; ySnapCvy=a.ySnapCvy; ySnapCvz=a.ySnapCvz;
      ySpinRate=a.ySpinRate; ySpinPhase=a.ySpinPhase; yCspinPhase=a.yCspinPhase;
      ySpinAxX=a.ySpinAxX; ySpinAxY=a.ySpinAxY; ySpinAxZ=a.ySpinAxZ;
    },
    setLedgers(l) {
      sinkTideE=l.sinkTideE; sinkGWE=l.sinkGWE; sinkGWLx=l.sinkGWLx; sinkGWLv=l.sinkGWLv;
      sinkGWLz=l.sinkGWLz; fieldPx=l.fieldPx; fieldPv=l.fieldPv; fieldPz=l.fieldPz;
    }
  }),
  fns: () => ({
    ensureCap, zeroKahan, resetLedger, computeAccel, accumulateAccel,
    drift, kick, stageMidpoint, spinVecUpdate,
    iasEnsureBuffers, iasPredictNextStep, iasStepTry, stepIAS15, stepIAS15Adaptive,
    stepYoshida4, scanPairStats, calcAdaptiveDt, advanceAdaptiveYoshida,
    refreshBodyTideCache, computeTotalEnergy, computeGWStrainCore,
    kahanAdd, iasSqrt7, massRadius, autoK2, autoTideLag, isBlackHolePhys
  })
};
