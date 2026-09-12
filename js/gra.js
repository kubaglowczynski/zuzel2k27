
/* ============================================================================
   ŻUŻEL 3D — silnik gry
   Fizyka i model toru przetestowane offline (czasy kolejek ~17 s, tor 349 m).
   ========================================================================= */
"use strict";

/* ======================= RDZEŃ SYMULACJI ======================= */
/* ==========================================================================
   ŻUŻEL 3D — rdzeń symulacji (tor, fizyka motocykla, stan nawierzchni, AI)
   Jednostki SI: metry, sekundy, kilogramy, niutony, radiany.
   ========================================================================== */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => v > a ? (v < b ? v : b) : a;   // NaN-safe -> a
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);
function mod(a, n) { return ((a % n) + n) % n; }
function angWrap(a) { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; }

/* --------------------------------------------------------------------------
   TOR — owal typu "stadion": 2 proste + 2 łuki, jazda w lewo (przeciwnie do
   wskazówek zegara). Długość mierzona przy krawężniku ~396 m (tor 400-metrowy).
   -------------------------------------------------------------------------- */
const TRK = {
  S: 48,      // połowa długości prostej (prosta = 96 m)
  R: 32,      // promień osi toru w łuku
  HW: 7.0,    // połowa szerokości toru (tor 14 m)
  BANK: 1.15  // przechyłka na zewnętrznej krawędzi łuku [m]
};
TRK.L = 4 * TRK.S + TAU * TRK.R;              // długość osi toru
TRK.LEN_INNER = 4 * TRK.S + TAU * (TRK.R - TRK.HW);
TRK.SEG1 = 2 * TRK.S;                          // koniec prostej A (start/meta na niej)
TRK.SEG2 = TRK.SEG1 + Math.PI * TRK.R;         // koniec łuku 1-2
TRK.SEG3 = TRK.SEG2 + 2 * TRK.S;               // koniec prostej B
TRK.START_S = TRK.SEG1 - 58;                   // linia startu/mety: 62 m przed łukiem 1

// pozycja + kierunek + krzywizna w danym dystansie s wzdłuż osi toru
function trackPos(s) {
  s = mod(s, TRK.L);
  const { S, R } = TRK;
  if (s < TRK.SEG1) return { x: -S + s, z: R, hx: 1, hz: 0, k: 0, phase: 0 };
  if (s < TRK.SEG2) {
    const t = (s - TRK.SEG1) / R, phi = Math.PI / 2 - t;
    return { x: S + R * Math.cos(phi), z: R * Math.sin(phi), hx: Math.sin(phi), hz: -Math.cos(phi), k: 1 / R, phase: t / Math.PI };
  }
  if (s < TRK.SEG3) { const d = s - TRK.SEG2; return { x: S - d, z: -R, hx: -1, hz: 0, k: 0, phase: 0 }; }
  const t = (s - TRK.SEG3) / R, phi = -Math.PI / 2 - t;
  return { x: -S + R * Math.cos(phi), z: R * Math.sin(phi), hx: Math.sin(phi), hz: -Math.cos(phi), k: 1 / R, phase: t / Math.PI };
}

// świat -> (s wzdłuż osi, lat: + na zewnątrz / - do krawężnika)
function toTrack(x, z) {
  const { S, R, L } = TRK;
  if (x > S) {
    const dx = x - S, r = Math.hypot(dx, z), phi = Math.atan2(z, dx);
    return { s: mod(TRK.SEG1 + (Math.PI / 2 - phi) * R, L), lat: r - R, r };
  }
  if (x < -S) {
    const dx = x + S, r = Math.hypot(dx, z);
    let phi = Math.atan2(z, dx); if (phi > -Math.PI / 2) phi -= TAU;
    return { s: mod(TRK.SEG3 + (-Math.PI / 2 - phi) * R, L), lat: r - R, r };
  }
  if (z >= 0) return { s: mod(x + S, L), lat: z - R, r: 0 };
  return { s: mod(TRK.SEG2 + (S - x), L), lat: -z - R, r: 0 };
}

// (s, lat) -> świat
function fromTrack(s, lat) {
  const p = trackPos(s);
  const nx = -p.hz, nz = p.hx;      // normalna "na zewnątrz"
  return { x: p.x + nx * lat, z: p.z + nz * lat, hx: p.hx, hz: p.hz, k: p.k };
}

// wysokość nawierzchni (przechyłka w łukach, gładkie przejście na prostych)
function surfaceY(s, lat) {
  const p = trackPos(s);
  let bankMix = p.k > 0 ? 1 : 0;
  if (p.k > 0) bankMix = smooth(clamp(Math.min(p.phase, 1 - p.phase) * 4.5, 0, 1)) * 0.75 + 0.25;
  else {
    const d1 = Math.min(mod(TRK.SEG1 - s, TRK.L), mod(s - TRK.SEG2, TRK.L));
    const d2 = Math.min(mod(TRK.SEG3 - s, TRK.L), mod(s - 0, TRK.L));
    bankMix = clamp(1 - Math.min(d1, d2) / 26, 0, 1) * 0.35;
  }
  const u = clamp((lat + TRK.HW) / (2 * TRK.HW), 0, 1);
  return TRK.BANK * bankMix * Math.pow(u, 1.7);
}

// dystans wyścigowy liczony od linii startu
function raceProgress(s) { return mod(s - TRK.START_S, TRK.L); }

/* --------------------------------------------------------------------------
   NAWIERZCHNIA — siatka stanu toru.
   dirt   = warstwa luźnej ziemi (przyczepność w "bandzie"/kożuchu)
   polish = wypolerowana, twarda ścieżka ("blue groove") — mniej czepna
   Zawodnicy zdzierają ziemię z linii jazdy i wyrzucają ją na zewnątrz.
   -------------------------------------------------------------------------- */
const NS = 192, NL = 22;
class Surface {
  constructor(seed = 1) {
    this.dirt = new Float32Array(NS * NL);
    this.polish = new Float32Array(NS * NL);
    this.rut = new Float32Array(NS * NL);
    let r = seed;
    const rnd = () => (r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < NS; i++) for (let j = 0; j < NL; j++) {
      const v = j / (NL - 1);
      // świeżo przygotowany tor: równa warstwa, minimalnie grubsza przy bandzie
      this.dirt[i * NL + j] = 0.52 + 0.10 * v + 0.05 * (rnd() - 0.5);
    }
  }
  // stan przed biegiem: 0 = świeżo równany, 1 = po serii biegów (wyjeżdżony dołek + kożuch)
  preWear(w) {
    if (w <= 0) return;
    for (let i = 0; i < NS; i++) for (let j = 0; j < NL; j++) {
      const v = j / (NL - 1);                       // 0 = krawężnik, 1 = banda
      const groove = Math.exp(-Math.pow((v - 0.30) / 0.17, 2));   // wyjeżdżona ścieżka
      const cushion = Math.pow(clamp((v - 0.62) / 0.38, 0, 1), 1.5);
      const k = i * NL + j;
      this.polish[k] = Math.min(1, this.polish[k] + w * 0.78 * groove);
      this.rut[k] = Math.min(1, this.rut[k] + w * 0.55 * groove);
      this.dirt[k] = clamp(this.dirt[k] - w * 0.34 * groove + w * 0.46 * cushion, 0, 1.05);
    }
  }
  idx(s, lat) {
    const i = clamp(Math.floor(mod(s, TRK.L) / TRK.L * NS), 0, NS - 1);
    const j = clamp(Math.floor((lat + TRK.HW) / (2 * TRK.HW) * NL), 0, NL - 1);
    return i * NL + j;
  }
  // współczynnik przyczepności 0.62..1.16
  grip(s, lat) {
    const k = this.idx(s, lat);
    const d = this.dirt[k], p = this.polish[k];
    return clamp(0.84 + 0.42 * Math.min(d, 0.95) - 0.40 * p - 0.09 * this.rut[k], 0.62, 1.22);
  }
  // Głębokość luźnego materiału: 0 na ubitym torze, 1 w usypanym kożuchu przy
  // bandzie. Służy wyłącznie do naliczania oporu jazdy tą ścieżką.
  oporLuzu(s, lat) {
    const d = this.dirt[this.idx(s, lat)];
    // Próg 0.74 był tak wysoki, że kara włączała się dopiero w ostatnich
    // 60 cm przed bandą, a na świeżo równanym torze wcale. Przy 0.68 obejmuje
    // cały kożuch, ale na świeżym torze (ziemia 0.59-0.64) nadal daje zero —
    // i słusznie, bo tam nie ma się w co wkopać.
    return clamp((d - 0.68) / 0.22, 0, 1);
  }
  bump(s, lat) { const k = this.idx(s, lat); return this.rut[k] * 0.7 + Math.max(0, this.dirt[k] - 0.75) * 0.9; }
  // przejazd motocykla: poleruje ścieżkę, zdziera ziemię i wyrzuca ją na zewnątrz
  pass(s, lat, slide, drive, dt) {
    const i = clamp(Math.floor(mod(s, TRK.L) / TRK.L * NS), 0, NS - 1);
    const jf = (lat + TRK.HW) / (2 * TRK.HW) * NL;
    const j = clamp(Math.floor(jf), 0, NL - 1);
    const k = i * NL + j;
    const work = dt * (0.55 + 1.7 * slide) * (0.35 + 0.95 * drive);
    const scrub = Math.min(this.dirt[k], work * 0.85);
    this.dirt[k] -= scrub;
    this.polish[k] = Math.min(1, this.polish[k] + work * 0.62);
    this.rut[k] = Math.min(1, this.rut[k] + work * 0.34);
    const jo = Math.min(NL - 1, j + 2 + (slide > 0.45 ? 1 : 0));
    this.dirt[i * NL + jo] = Math.min(1.05, this.dirt[i * NL + jo] + scrub * 0.80);
    if (j > 0) this.polish[i * NL + (j - 1)] = Math.min(1, this.polish[i * NL + (j - 1)] + work * 0.20);
    if (j < NL - 1) this.polish[k + 1] = Math.min(1, this.polish[k + 1] + work * 0.20);
  }
}

/* --------------------------------------------------------------------------
   MOTOCYKL ŻUŻLOWY — 500 ccm, jeden bieg, brak hamulców, metanol.
   Model rowerowy 2D + koło tarcia z priorytetem napędu (power oversteer),
   sprzęgło cierne o ograniczonej pojemności momentu, ogranicznik obrotów.
   -------------------------------------------------------------------------- */
const P = {
  m: 155, Iz: 48, a: 0.72, b: 0.63, h: 0.565, rW: 0.36,
  mu: 1.88, muF: 1.02, muR: 0.92, latR: 0.72, Bf: 6.0, Cf: 1.42, Br: 3.6, Cr: 1.52,
  G: 13.8, Ie: 0.055, Tcap: 96, rpmIdle: 1700, rpmMax: 12200, Tpeak: 62,
  kDrag: 0.225, crr: 0.028, yawDamp: 52, dMax: 0.72, dRate: 4.8,   // 41° wykrętu — tyle trzeba, by utrzymać głęboki ślizg
  INERT: 0.655        // korekta na bezwładność wirujących mas przy zamkniętym sprzęgle
};
const rpm2rad = (r) => r * TAU / 60, rad2rpm = (w) => w * 60 / TAU;

function engineTorque(rpm, thr) {
  // Ogranicznik gaśnie łagodnie zamiast ucinać moment nożem — wcześniej przy
  // 100% obrotów moment spadał z 59 Nm na -14 Nm w jednym kroku i prędkość
  // przyklejała się do sufitu, co czuć było jak sztuczna blokada.
  const f = clamp(rpm / P.rpmMax, 0, 1.20);
  const g = Math.min(f, 1);
  let t = P.Tpeak * (0.45 + 1.45 * g - 0.95 * g * g);
  if (f > 0.93) t *= clamp(1 - (f - 0.93) / 0.16, 0, 1);
  const brake = -7 * (0.35 + 0.65 * g);        // słabsze hamowanie silnikiem
  return lerp(brake, t, clamp(thr, 0, 1));
}
function tireF(alpha, muFz, B, C) { return -muFz * Math.sin(C * Math.atan(B * alpha)); }

class Bike {
  constructor(cfg) {
    this.skill = 1; this.style = 0.5; this.adapt = 0.8; this.aggro = 0.6; this.gripMul = 1; this.id = 0;
    this.assist = 1;   // odruch jeźdźca: but stalowy + balans ciała (2D model tego nie ma)
    this.tol = 1;      // tolerancja upadku — łagodniejsza na niższych poziomach trudności
    Object.assign(this, cfg);
    this.x = 0; this.z = 0; this.psi = 0; this.u = 0; this.w = 0; this.r = 0;
    this.we = rpm2rad(P.rpmIdle); this.clutch = 0; this.thr = 0; this.steer = 0; this.steerCmd = 0;
    this.spin = 0; this.lean = 0; this.roll = 0; this.slipAng = 0; this.wheelie = 0;
    this.lap = 0; this.prog = 0; this.total = 0; this.finished = false; this.finishT = 0;
    this.down = 0; this.downT = 0; this.contact = 0; this.lat = 0; this.s = 0;
    this.kozuchT = 0; this.wLuzie = 0;   // czas jazdy w kożuchu i wynikający z niego opór
    this.lapTimes = []; this.lastLapT = 0; this.pos = 1; this.exclu = null;
    this.gLat = 0; this.dirtRate = 0; this.wheelSpinVis = 0; this.rideWeight = 0;
  }
  get speed() { return Math.hypot(this.u, this.w); }
  get rpm() { return rad2rpm(this.we); }
  fwd() { return { x: Math.sin(this.psi), z: Math.cos(this.psi) }; }

  step(dt, inp, surf, time) {
    // --- upadek: zawodnik zbiera motocykl ---
    if (this.down > 0) {
      this.down -= dt; this.u *= Math.pow(0.02, dt); this.w *= Math.pow(0.02, dt); this.r *= Math.pow(0.02, dt);
      this.we = lerp(this.we, rpm2rad(P.rpmIdle), 1 - Math.pow(0.05, dt));
      this.x += this.u * Math.sin(this.psi) * dt; this.z += this.u * Math.cos(this.psi) * dt;
      if (this.down <= 0) { // podniesienie się i ustawienie w kierunku jazdy
        const t = toTrack(this.x, this.z), p = trackPos(t.s);
        this.psi = Math.atan2(p.hx, p.hz); this.u = 2.0; this.w = 0; this.r = 0; this.clutch = 1;
      }
      this.updateProgress(time); return;
    }

    const thrIn = clamp(inp.throttle, 0, 1);
    this.thr = lerp(this.thr, thrIn, 1 - Math.pow(0.0006, dt));         // przepustnica ma bezwładność
    this.steerCmd = clamp(inp.steer, -1, 1);
    const dTarget = this.steerCmd * P.dMax;
    this.steer += clamp(dTarget - this.steer, -P.dRate * dt, P.dRate * dt);
    const clutchTarget = inp.clutch ? 0 : 1;
    this.clutch += clamp(clutchTarget - this.clutch, -14 * dt, (inp.launchRate || 3.1) * dt);
    this.clutch = clamp(this.clutch, 0, 1);

    const v = Math.max(this.speed, 0.001);
    const tr = toTrack(this.x, this.z); this.s = tr.s; this.lat = tr.lat;
    const grip = surf.grip(tr.s, tr.lat);
    const onGrass = tr.lat < -TRK.HW - 0.25 || tr.lat > TRK.HW + 0.25;
    const mu = P.mu * grip * (onGrass ? 0.42 : 1) * (this.gripMul || 1);

    // --- silnik / sprzęgło ---
    const ww = this.u / P.rW * (1 + this.spin);
    const weq = ww * P.G;
    let Fdem = 0;
    const locked = this.clutch > 0.985 && this.we <= weq + 6;
    if (locked) {
      this.we = Math.max(rpm2rad(P.rpmIdle), weq);
      const Te = engineTorque(this.rpm, this.thr);
      Fdem = Te * P.G / P.rW * P.INERT;
    } else {
      const Te = engineTorque(this.rpm, this.thr);
      const dir = Math.sign(this.we - weq) || 1;
      const Tc = this.clutch * P.Tcap * dir;
      this.we += (Te - Tc) / P.Ie * dt;
      this.we = clamp(this.we, rpm2rad(700), rpm2rad(P.rpmMax * 1.18));
      Fdem = Tc * P.G / P.rW * 0.94;
      if (this.clutch < 0.02) Fdem = 0;
    }

    // --- obciążenia pionowe + transfer masy (jazda "na tylnym") ---
    const W = P.m * 9.81, wb = P.a + P.b;
    const wShift = clamp(this.rideWeight || 0, -1, 1) * 0.15;   // balans ciała jeźdźca
    // transfer wzdłużny liczony z SIŁY zewnętrznej (nie z przyspieszenia w układzie
    // ruchomym) i twardo ograniczony — inaczej powstaje pętla dodatniego sprzężenia
    const Tsh = clamp((this.fxPrev || 0) * P.h / wb, -W * 0.30, W * 0.30);
    // wShift > 0 = jeździec przenosi ciężar do przodu (docisk przedniego koła)
    let Fzf = clamp(W * (P.b + wShift) / wb - Tsh, 0, W * 1.02);
    let Fzr = clamp(W * (P.a - wShift) / wb + Tsh, W * 0.18, W * 1.02);
    this.wheelie = clamp(1 - Fzf / 420, 0, 1);

    // --- opona tylna: napęd ma pierwszeństwo, reszta koła tarcia na bok ---
    const capR = mu * P.muR * Fzr;
    // Koło pracujące bokiem nie przeniesie pełnego napędu — bez tego sprzężenia
    // motocykl rozpędzał się w łuku do prędkości, przy której już nie skręcał.
    const bocz = clamp(Math.abs(this.arPrev || 0) / 0.30, 0, 1);
    const capDrive = capR * (1 - 0.15 * bocz);
    let Fx = Fdem;
    if (Fx > capDrive) { this.spin = Math.min(0.60, this.spin + (Fx / Math.max(capDrive, 1) - 1) * 2.4 * dt); Fx = capDrive * 0.94; }
    else { this.spin = Math.max(0, this.spin - 2.6 * dt); }
    if (Fx < -capR) Fx = -capR;
    const used = clamp(Fx / Math.max(capR, 1), -1, 1);
    // Tylna opona oddaje napęd w całości, ale bocznie trzyma znacznie słabiej —
    // stąd bierze się żużlowy ślizg. Rozdzielenie tych dwóch zapasów pozwala
    // zachować przyspieszenie i jednocześnie puścić tył w łuku.
    const latCap = capR * P.latR * Math.sqrt(Math.max(0, 1 - used * used * 0.97)) * (1 - 0.55 * this.spin);

    const ar = Math.atan2(this.w - P.b * this.r, Math.max(this.u, 1.2));
    const af = Math.atan2(this.w + P.a * this.r, Math.max(this.u, 1.2)) - this.steer;
    let Fyr = tireF(ar, capR, P.Br, P.Cr);
    Fyr = clamp(Fyr, -latCap, latCap);
    this.arPrev = ar;
    const Fyf = tireF(af, mu * P.muF * Fzf, P.Bf, P.Cf);

    // --- opory ---
    const drag = P.kDrag * v * v;
    const roll = P.crr * P.m * 9.81 * (1 + 0.9 * Math.abs(Math.sin(this.slipAng)));
    // KOŻUCH POD BANDĄ — wyłącznie dla gracza i wyłącznie w łuku. Na prostej
    // materiał jest ubity, a AI trzyma się bliżej krawężnika, więc nie ma czego
    // karać. Opona musi najpierw rozgrzebać wierzchnią warstwę, więc przez
    // pierwsze dwie sekundy nic nie czuć — dopiero potem motocykl wyraźnie siada.
    // Po zejściu z tej ścieżki opór znika w niecałą sekundę.
    const wLuku = trackPos(tr.s).k > 0;
    const luz = (this.gracz && wLuku && surf.oporLuzu) ? surf.oporLuzu(tr.s, tr.lat) : 0;
    this.kozuchT = luz > 0.08 ? Math.min(2.0, this.kozuchT + dt) : Math.max(0, this.kozuchT - dt * 2.2);
    // USTAWIENIE AUTORA po testach na torze — nie zmieniać bez jego zgody.
    // Dzielnik 1.5 przy suficie licznika 2.0 sprawia, że po pełnym wkopaniu
    // opór rośnie DALEJ, do 1,78 raza, jeśli gracz uparcie trzyma tę ścieżkę.
    const narost = Math.pow(this.kozuchT / 1.5, 2);
    const oporLuzny = luz * narost * (1100 + 90 * v);
    this.wLuzie = luz * narost;
    const Fxt = Fx - (drag + roll + oporLuzny) * (this.u / v);

    // --- równania ruchu (układ związany z motocyklem) ---
    const du = (Fxt) / P.m + this.w * this.r;
    const dw = (Fyf * Math.cos(this.steer) + Fyr) / P.m - this.u * this.r;
    let Mz = P.a * Fyf * Math.cos(this.steer) - P.b * Fyr - P.yawDamp * this.r;
    // łapanie zarzucenia: powyżej ~20° znoszenia jeździec aktywnie hamuje obrót
    const bNow = Math.atan2(this.w, Math.max(this.u, 0.5));
    const bExc = bNow - clamp(bNow, -0.62, 0.62);   // broadslide do ~35° to norma, nie ratunek
    Mz += this.assist * (3800 * bExc - 34 * this.r * clamp(Math.abs(bNow) / 0.62, 0, 1));
    this.u += du * dt; this.w += dw * dt; this.r = clamp(this.r + Mz / P.Iz * dt, -5.5, 5.5);
    this.u = Math.max(this.u, -2); this.w = clamp(this.w, -26, 26);
    this.fxPrev = Fxt;
    this.gLat = (Fyf + Fyr) / (P.m * 9.81);

    this.psi += this.r * dt;
    this.x += (this.u * Math.sin(this.psi) + this.w * Math.cos(this.psi)) * dt;
    this.z += (this.u * Math.cos(this.psi) - this.w * Math.sin(this.psi)) * dt;

    this.slipAng = Math.atan2(this.w, Math.max(this.u, 0.5));
    const slide = clamp(Math.abs(this.slipAng) / 0.75, 0, 1);
    this.wheelSpinVis = this.spin;
    this.dirtRate = clamp(slide * 0.75 + this.spin * 1.6, 0, 1) * clamp(v / 8, 0, 1);
    surf.pass(tr.s, tr.lat, slide, clamp(Fx / 1600, 0, 1), dt);

    // --- przechył (wizualny) + nierówności ---
    const targetRoll = clamp(Math.atan2(-this.gLat * 9.81, 9.81) * 1.15, -0.85, 0.85);
    this.roll = lerp(this.roll, targetRoll, 1 - Math.pow(0.030, dt));
    const bump = surf.bump(tr.s, tr.lat);
    if (bump > 0.05 && v > 6) this.r += (Math.sin(time * 31 + this.id * 7) * bump * 0.30) * dt;

    // --- bandy i krawężnik ---
    this.contact = Math.max(0, this.contact - dt * 2);
    const lim = TRK.HW - 0.35;
    if (tr.lat > lim) {
      const p = trackPos(tr.s), nx = -p.hz, nz = p.hx;
      const over = tr.lat - lim;
      this.x -= nx * over; this.z -= nz * over;
      const fx = Math.sin(this.psi), fz = Math.cos(this.psi), lx = Math.cos(this.psi), lz = -Math.sin(this.psi);
      let vx = this.u * fx + this.w * lx, vz = this.u * fz + this.w * lz;
      const vn = vx * nx + vz * nz;
      if (vn > 0) {
        // dmuchana banda pochłania uderzenie: znosi składową normalną i zabiera trochę pędu
        vx -= vn * 1.12 * nx; vz -= vn * 1.12 * nz;
        const strata = clamp(1 - vn * 0.030, 0.62, 1);
        vx *= strata; vz *= strata;
        this.u = vx * fx + vz * fz; this.w = vx * lx + vz * lz;
        this.r *= 0.86;
      }
      this.contact = 1;
      if (vn > 11.5 * this.tol && v > 16) { this.fall('banda'); this.brutalnaBanda = vn > 14; }
    }
    const limIn = -TRK.HW + 0.30;
    if (tr.lat < limIn) {
      const p = trackPos(tr.s), nx = -p.hz, nz = p.hx;
      const over = limIn - tr.lat;
      this.x += nx * over * 0.9; this.z += nz * over * 0.9;
      this.u *= clamp(1 - over * 1.4, 0.55, 1);
      this.contact = 1;
      if (over > 0.55 * this.tol && v > 15) this.fall('krawężnik');
    }
    if (Math.abs(this.slipAng) > 0.98 * this.tol && v > 12) this.fall('obrót');

    this.updateProgress(time);
  }

  fall(why) { if (this.down > 0) return; this.fallReason = why || '?'; this.down = 2.6; this.downT = 1; this.falls = (this.falls || 0) + 1; this.spin = 0; }

  updateProgress(time) {
    const tr = toTrack(this.x, this.z);
    const pr = raceProgress(tr.s);
    if (this.prog > TRK.L * 0.75 && pr < TRK.L * 0.25) {
      this.lap++; this.lapTimes.push(time - this.lastLapT); this.lastLapT = time;
    } else if (this.prog < TRK.L * 0.25 && pr > TRK.L * 0.75 && this.lap > 0) this.lap--;
    this.prog = pr; this.total = this.lap * TRK.L + pr;
  }
}

/* --------------------------------------------------------------------------
   AI — linia jazdy, dozowanie gazu, walka o pozycję
   -------------------------------------------------------------------------- */
function lineTarget(s, style) {
  const p = trackPos(s);
  const apex = -4.6 + 6.6 * style;
  const entry = 2.0 + 2.2 * style;
  const exit = 0.4 + 3.0 * style;
  let base;
  if (p.k > 0) {
    const t = p.phase;
    if (t < 0.45) base = lerp(entry, apex, smooth(t / 0.45));
    else base = lerp(apex, exit, smooth((t - 0.45) / 0.55));
  } else {
    const d = mod(s, TRK.L);
    let q;
    if (d < TRK.SEG1) q = d / TRK.SEG1;
    else q = (d - TRK.SEG2) / (TRK.SEG3 - TRK.SEG2);
    base = lerp(exit, entry, smooth(clamp(q * 1.35 - 0.05, 0, 1)));
  }
  return clamp(base, -TRK.HW + 1.25, TRK.HW - 2.2);
}

// odległość do początku najbliższego łuku (0 gdy już w łuku)
function distToTurn(s) {
  s = mod(s, TRK.L);
  if (s < TRK.SEG1) return TRK.SEG1 - s;
  if (s >= TRK.SEG2 && s < TRK.SEG3) return TRK.SEG3 - s;
  return 0;
}

const AI_DEC = 3.4;   // opóźnienie osiągalne ślizgiem [m/s^2] – żużlowiec nie ma hamulców

function aiControl(bk, all, surf, t, cfg) {
  const inp = { throttle: 0, steer: 0, clutch: false };
  if (bk.down > 0) return inp;
  const tr = toTrack(bk.x, bk.z);
  const v = Math.max(bk.speed, 0.6);
  const pNow = trackPos(tr.s);
  const inTurn = pNow.k > 0;
  const dTurn = distToTurn(tr.s);

  // --- wybór ścieżki: styl + odczyt toru (kożuch przy bandzie vs wypolerowany dołek)
  const gIn = surf.grip(tr.s + 30, -3.8), gOut = surf.grip(tr.s + 30, 4.2);
  // Bez tego wszyscy przyklejają się do jednej ścieżki i bieg wygląda jak
  // przejazd pociągu. Każdy zawodnik dostaje własną fazę i tempo błądzenia,
  // więc szuka miejsca po całej szerokości toru zamiast trzymać jeden ślad.
  if (bk.fazaLinii === undefined) {
    bk.fazaLinii = (bk.id * 2.399 + 0.7) % 6.283;
    bk.tempoLinii = 0.20 + ((bk.id * 37) % 11) * 0.018;
    bk.szumLinii = 0;
  }
  bk.szumLinii = bk.szumLinii * 0.991 + (Math.random() - 0.5) * 0.012;
  const bladzenie = Math.sin(t * bk.tempoLinii + bk.fazaLinii) * 0.135 + bk.szumLinii;
  const style = clamp(bk.style + bladzenie + (gOut - gIn) * 2.1 * bk.adapt, 0.02, 0.98);
  const look = clamp(6.5 + v * 0.52, 8, 21);
  let latT = lineTarget(tr.s + look, style);

  // --- ruch na torze: szukanie luki
  let ahead = null, aheadD = 99;
  for (const o of all) {
    if (o === bk || o.down > 0) continue;
    const d = o.total - bk.total;
    if (d > 0.4 && d < 14 && d < aheadD) { aheadD = d; ahead = o; }
    if (d < 0 && d > -5.5 && Math.abs(o.lat - tr.lat) < 1.9)
      latT = clamp(latT + Math.sign(tr.lat - o.lat || 1) * 1.5, -TRK.HW + 1.0, TRK.HW - 1.0);
  }
  if (ahead && Math.abs(ahead.lat - latT) < 2.4) {
    const roomIn = ahead.lat - (-TRK.HW + 1.2), roomOut = (TRK.HW - 1.2) - ahead.lat;
    const goOut = roomOut > roomIn ? 1 : -1;
    const attack = clamp(bk.aggro * (1 - aheadD / 14), 0, 1) * 0.75;
    latT = lerp(latT, clamp(ahead.lat + goOut * 2.9, -TRK.HW + 1.2, TRK.HW - 1.2), attack);
  }

  // --- linia zmieniana płynnie, nie skokowo
  const dtA = cfg.dt || 1 / 60;
  if (bk.latSm === undefined) bk.latSm = latT;
  bk.latSm += clamp(latT - bk.latSm, -7 * dtA, 7 * dtA);
  latT = bk.latSm;

  // --- regulator śledzenia toru: krzywizna linii + błąd kursu + błąd poprzeczny
  const pRef = trackPos(tr.s);
  const spB = Math.sin(bk.psi), cpB = Math.cos(bk.psi);
  const vxB = bk.u * spB + bk.w * cpB, vzB = bk.u * cpB - bk.w * spB;
  const course = (v > 1.5) ? Math.atan2(vxB, vzB) : bk.psi;
  const psiErr = angWrap(course - Math.atan2(pRef.hx, pRef.hz));   // < 0 = znosi na zewnątrz
  const eLat = tr.lat - latT;                                      // > 0 = jedzie za szeroko
  const kPath = pRef.k > 0 ? 1 / Math.max(TRK.R + latT, 12) : 0;
  let rDes = clamp(v * kPath - 1.55 * psiErr + clamp(eLat, -6, 6) * 2.4 / Math.max(v, 9), -1.9, 1.9);

  // --- model odwrotny opony przedniej:
  //     alfa_f = beta + a*r/u - delta   =>   delta = beta + a*r/u - alfa_zadane
  const beta = bk.slipAng;
  const err = rDes - bk.r;
  bk.aiI = clamp((bk.aiI || 0) + err * dtA * 1.4, -0.24, 0.24);
  if (Math.abs(err) < 0.03) bk.aiI *= Math.pow(0.7, dtA * 60);
  const alphaCmd = -clamp(1.05 * err + bk.aiI, -0.32, 0.32);
  const steerRad = clamp(beta + P.a * bk.r / Math.max(v, 5) - alphaCmd, -P.dMax, P.dMax);
  bk.aiSteer = lerp(bk.aiSteer === undefined ? steerRad : bk.aiSteer, steerRad, clamp(dtA * 18, 0, 1));
  inp.steer = clamp(bk.aiSteer, -P.dMax, P.dMax) / P.dMax;

  // --- prędkość dopuszczalna z wyprzedzeniem
  let vLim = 31.6;
  for (let d = 4; d <= 80; d += 4) {
    const pp = trackPos(tr.s + d);
    if (pp.k <= 0) continue;
    const la = lineTarget(tr.s + d, style);
    const g = surf.grip(tr.s + d, la);
    const vc = Math.sqrt(P.mu * g * 9.81 * (TRK.R + la)) * 0.885 * cfg.pace * bk.skill;
    vLim = Math.min(vLim, Math.sqrt(vc * vc + 2 * AI_DEC * d));
  }

  if (tr.lat > TRK.HW - 2.4) vLim -= (tr.lat - (TRK.HW - 2.4)) * 2.2;
  let thr = clamp((vLim - v) * 0.34 + 0.12, 0, 1);
  const pitchIn = (!inTurn && dTurn < 24 && v > 22) ? 1 : 0;
  if (pitchIn) thr = Math.min(thr, 0.05);
  // w łuku gaz utrzymuje ślizg — ale nigdy ponad limit prędkości linii
  const sl = Math.abs(beta);
  if (inTurn && v < vLim - 0.4) {
    const bTarget = 0.30 + 0.16 * pNow.phase;
    thr = Math.max(thr, clamp(0.34 + (bTarget - sl) * 1.4, 0, 1));
  }
  if (sl > 0.62) thr *= clamp(1 - (sl - 0.62) * 3.0, 0.05, 1);
  if (bk.contact > 0.3) thr *= 0.80;
  if (tr.lat > TRK.HW - 1.1) thr *= 0.55;
  thr *= 1 + 0.05 * Math.sin(t * 2.7 + bk.id * 2) * (1.2 - bk.skill);
  inp.throttle = clamp(thr, 0, 1);
  bk.rideWeight = clamp(inTurn ? -0.15 + 0.5 * pNow.phase : 0.85 - bk.spin * 1.2, -1, 1);
  return inp;
}

/* ======================= ZAWODNICY ======================= */
// Kolory kasków wg pozycji startowych: 1 czerwony, 2 niebieski, 3 biały, 4 żółty
const KASKI = ['#d81f1f', '#1f5fd6', '#f0f0ee', '#f2c500'];
const POLA = ['A', 'B', 'C', 'D'];
const ZAWODNICY = [
  { imie: 'Marek Rydz', kraj: 'Pole A — przy krawężniku', styl: 0.10, skill: 1.00, aggro: 0.55, adapt: 0.55,
    opis: 'Startowiec. Wychodzi spod taśmy jak z procy i zamyka dołek przy krawężniku.',
    stat: { Start: 0.94, Ślizg: 0.62, Banda: 0.34 }, kevlar: '#c62828', pas: '#f7d54a' },
  { imie: 'Igor Sowa', kraj: 'Pole B — ścieżka środkowa', styl: 0.34, skill: 0.985, aggro: 0.70, adapt: 0.85,
    opis: 'Czyta tor lepiej niż ktokolwiek. Przekłada się tam, gdzie została ziemia.',
    stat: { Start: 0.66, Ślizg: 0.84, Banda: 0.66 }, kevlar: '#1c3f8f', pas: '#8fd0ff' },
  { imie: 'Adam Wilga', kraj: 'Pole C — druga ścieżka', styl: 0.56, skill: 0.99, aggro: 0.82, adapt: 0.70,
    opis: 'Walczy do końcowej prostej. Wchodzi kołem w koło i nie odpuszcza pierwszego łuku.',
    stat: { Start: 0.72, Ślizg: 0.78, Banda: 0.80 }, kevlar: '#e8e8e6', pas: '#2b2b2b' },
  { imie: 'Kamil Rosa', kraj: 'Pole D — po bandzie', styl: 0.78, skill: 1.00, aggro: 0.62, adapt: 0.60,
    opis: 'Specjalista od kożucha. Objeżdża po zewnętrznej tam, gdzie inni tracą przyczepność.',
    stat: { Start: 0.52, Ślizg: 0.92, Banda: 0.96 }, kevlar: '#c8a200', pas: '#1a1a1a' }
];
const POZIOMY = [
  // tol podniesione razem z tolerancją AI — upadek kończy teraz bieg, więc dawne
  // wartości karały gracza mocniej niż przed tą zmianą
  { n: 'Amator',     asysta: 1.06, pace: 0.900, dMax: 0.90, prowadz: 0.68, tol: 1.46 },
  { n: 'Zawodowiec', asysta: 0.74, pace: 0.960, dMax: 1.00, prowadz: 0.34, tol: 1.30 },
  { n: 'Legenda',    asysta: 0.26, pace: 1.000, dMax: 1.00, prowadz: 0.00, tol: 1.16 }
];
const STANY_TORU = [0.0, 0.55, 1.0];

/* ======================= DANE KLUBÓW I TABELA BIEGOWA ======================= */
const KLUBY = [{"id":"motor-lublin","n":"Motor Lublin","sk":"LUB","m":"Lublin","lg":"ekstraliga","b1":"#ffff00","b2":"#ffffff","dl":382,"sz":15,"st":"Best Auto Arena","z":[{"id":"motor-lublin-1","n":"Kacper Woryna","p":1,"r":"s","kr":"PL","s":81,"st":80,"sl":86,"ag":54,"sj":75,"ct":73},{"id":"motor-lublin-2","n":"Martin Vaculik","p":2,"r":"s","kr":"SK","s":70,"st":67,"sl":74,"ag":66,"sj":65,"ct":74},{"id":"motor-lublin-3","n":"Bartosz Zmarzlik","p":3,"r":"s","kr":"PL","s":96,"st":93,"sl":95,"ag":58,"sj":70,"ct":82},{"id":"motor-lublin-4","n":"Mateusz Cierniak","p":4,"r":"s","kr":"PL","s":67,"st":71,"sl":67,"ag":69,"sj":66,"ct":71},{"id":"motor-lublin-5","n":"Fredrik Lindgren","p":5,"r":"s","kr":"SE","s":71,"st":75,"sl":73,"ag":72,"sj":70,"ct":74},{"id":"motor-lublin-6","n":"Bartosz Bańbor","p":6,"r":"j","kr":"PL","s":66,"st":71,"sl":65,"ag":69,"sj":24,"ct":76},{"id":"motor-lublin-7","n":"Bartosz Jaworski","p":7,"r":"j","kr":"PL","s":58,"st":64,"sl":58,"ag":73,"sj":32,"ct":64},{"id":"motor-lublin-8","n":"Dawid Cepielik","p":8,"r":"r","kr":"PL","s":30,"st":25,"sl":35,"ag":53,"sj":79,"ct":50}]},{"id":"sparta-wroclaw","n":"Sparta Wrocław","sk":"WRO","m":"Wrocław","lg":"ekstraliga","b1":"#ffcc00","b2":"#e30613","dl":387,"sz":15,"st":"Stadion Olimpijski","z":[{"id":"sparta-wroclaw-1","n":"Artem Laguta","p":1,"r":"s","kr":"RU","s":93,"st":93,"sl":94,"ag":46,"sj":70,"ct":87},{"id":"sparta-wroclaw-2","n":"Brady Kurtz","p":2,"r":"s","kr":"AU","s":84,"st":83,"sl":85,"ag":46,"sj":29,"ct":83},{"id":"sparta-wroclaw-3","n":"Maciej Janowski","p":3,"r":"s","kr":"PL","s":84,"st":81,"sl":83,"ag":45,"sj":61,"ct":70},{"id":"sparta-wroclaw-4","n":"Daniel Bewley","p":4,"r":"s","kr":"GB","s":84,"st":81,"sl":85,"ag":60,"sj":59,"ct":81},{"id":"sparta-wroclaw-5","n":"Bartłomiej Kowalski","p":5,"r":"s","kr":"PL","s":72,"st":78,"sl":77,"ag":55,"sj":66,"ct":65},{"id":"sparta-wroclaw-6","n":"Mikkel Andersen","p":6,"r":"j","kr":"DK","s":62,"st":60,"sl":58,"ag":74,"sj":26,"ct":78},{"id":"sparta-wroclaw-7","n":"Marcel Kowolik","p":7,"r":"j","kr":"PL","s":58,"st":53,"sl":57,"ag":55,"sj":45,"ct":69},{"id":"sparta-wroclaw-8","n":"Nikodem Mikołajczyk","p":8,"r":"r","kr":"PL","s":54,"st":55,"sl":54,"ag":57,"sj":70,"ct":65}]},{"id":"ks-torun","n":"KS Toruń","sk":"TOR","m":"Toruń","lg":"ekstraliga","b1":"#ffcc00","b2":"#0057a8","dl":325,"sz":15,"st":"Motoarena Toruń im. Mariana Rosego","z":[{"id":"ks-torun-1","n":"Mikkel Michelsen","p":1,"r":"s","kr":"DK","s":77,"st":77,"sl":76,"ag":69,"sj":57,"ct":81},{"id":"ks-torun-2","n":"Robert Lambert","p":2,"r":"s","kr":"GB","s":86,"st":88,"sl":88,"ag":65,"sj":64,"ct":73},{"id":"ks-torun-3","n":"Patryk Dudek","p":3,"r":"s","kr":"PL","s":83,"st":87,"sl":81,"ag":50,"sj":47,"ct":76},{"id":"ks-torun-4","n":"Norick Bloedorn","p":4,"r":"s","kr":"DE","s":71,"st":75,"sl":77,"ag":56,"sj":70,"ct":75},{"id":"ks-torun-5","n":"Emil Sajfutdinow","p":5,"r":"s","kr":"RU","s":88,"st":89,"sl":91,"ag":49,"sj":54,"ct":72},{"id":"ks-torun-6","n":"Oskar Rumiński","p":6,"r":"j","kr":"PL","s":35,"st":37,"sl":35,"ag":68,"sj":75,"ct":53},{"id":"ks-torun-7","n":"Nicolai Heiselberg","p":7,"r":"j","kr":"DK","s":34,"st":35,"sl":39,"ag":76,"sj":74,"ct":62},{"id":"ks-torun-8","n":"Antoni Kawczyński","p":8,"r":"r","kr":"PL","s":65,"st":71,"sl":65,"ag":61,"sj":25,"ct":77}]},{"id":"unia-leszno","n":"Unia Leszno","sk":"LES","m":"Leszno","lg":"ekstraliga","b1":"#ffffff","b2":"#0057b8","dl":330,"sz":15,"st":"Stadion im. Alfreda Smoczyka","z":[{"id":"unia-leszno-1","n":"Janusz Kołodziej","p":1,"r":"s","kr":"PL","s":81,"st":81,"sl":77,"ag":75,"sj":44,"ct":78},{"id":"unia-leszno-2","n":"Piotr Pawlicki","p":2,"r":"s","kr":"PL","s":81,"st":75,"sl":87,"ag":53,"sj":78,"ct":78},{"id":"unia-leszno-3","n":"Grzegorz Zengota","p":3,"r":"s","kr":"PL","s":74,"st":78,"sl":73,"ag":52,"sj":37,"ct":67},{"id":"unia-leszno-4","n":"Keynan Rew","p":4,"r":"s","kr":"AU","s":69,"st":67,"sl":65,"ag":53,"sj":54,"ct":76},{"id":"unia-leszno-5","n":"Ben Cook","p":5,"r":"s","kr":"AU","s":82,"st":79,"sl":80,"ag":53,"sj":40,"ct":72},{"id":"unia-leszno-6","n":"Nazar Parnitskyi","p":6,"r":"j","kr":"UA","s":78,"st":76,"sl":74,"ag":73,"sj":49,"ct":71},{"id":"unia-leszno-7","n":"Kacper Mania","p":7,"r":"j","kr":"PL","s":50,"st":56,"sl":46,"ag":67,"sj":22,"ct":64},{"id":"unia-leszno-8","n":"Maksymilian Kostera","p":8,"r":"r","kr":"PL","s":27,"st":30,"sl":30,"ag":71,"sj":13,"ct":63}]},{"id":"stal-gorzow","n":"Stal Gorzów","sk":"GOR","m":"Gorzów","lg":"ekstraliga","b1":"#ffd500","b2":"#003b7a","dl":329,"sz":15,"st":"Stadion im. Edwarda Jancarza","z":[{"id":"stal-gorzow-1","n":"Anders Thomsen","p":1,"r":"s","kr":"DK","s":92,"st":91,"sl":89,"ag":58,"sj":46,"ct":77},{"id":"stal-gorzow-2","n":"Jack Holder","p":2,"r":"s","kr":"AU","s":94,"st":91,"sl":94,"ag":44,"sj":32,"ct":86},{"id":"stal-gorzow-3","n":"Paweł Przedpełski","p":3,"r":"s","kr":"PL","s":67,"st":64,"sl":70,"ag":64,"sj":58,"ct":65},{"id":"stal-gorzow-4","n":"Mathias Pollestad","p":4,"r":"s","kr":"NO","s":72,"st":68,"sl":70,"ag":45,"sj":54,"ct":70},{"id":"stal-gorzow-5","n":"Hubert Jabłoński","p":5,"r":"s","kr":"PL","s":36,"st":30,"sl":40,"ag":58,"sj":48,"ct":54},{"id":"stal-gorzow-6","n":"Oskar Paluch","p":6,"r":"j","kr":"PL","s":71,"st":76,"sl":69,"ag":49,"sj":42,"ct":70},{"id":"stal-gorzow-7","n":"Adam Bednar","p":7,"r":"j","kr":"CZ","s":74,"st":74,"sl":77,"ag":60,"sj":13,"ct":79},{"id":"stal-gorzow-8","n":"Igor Kordun","p":8,"r":"r","kr":"UA","s":48,"st":42,"sl":43,"ag":73,"sj":77,"ct":59}]},{"id":"falubaz-zielona-gora","n":"Falubaz Zielona Góra","sk":"ZIE","m":"Zielona Góra","lg":"ekstraliga","b1":"#ffd500","b2":"#0b8f3c","dl":337,"sz":15,"st":"Stadion Miejski w Zielonej Górze","z":[{"id":"falubaz-zielona-gora-1","n":"Leon Madsen","p":1,"r":"s","kr":"DK","s":81,"st":86,"sl":79,"ag":49,"sj":70,"ct":78},{"id":"falubaz-zielona-gora-2","n":"Dominik Kubera","p":2,"r":"s","kr":"PL","s":77,"st":75,"sl":78,"ag":75,"sj":88,"ct":83},{"id":"falubaz-zielona-gora-3","n":"Andzejs Lebedevs","p":3,"r":"s","kr":"LV","s":76,"st":73,"sl":71,"ag":43,"sj":32,"ct":77},{"id":"falubaz-zielona-gora-4","n":"Przemysław Pawlicki","p":4,"r":"s","kr":"PL","s":76,"st":71,"sl":81,"ag":55,"sj":45,"ct":82},{"id":"falubaz-zielona-gora-5","n":"Damian Ratajczak","p":5,"r":"s","kr":"PL","s":66,"st":70,"sl":65,"ag":52,"sj":81,"ct":78},{"id":"falubaz-zielona-gora-6","n":"Oskar Hurysz","p":6,"r":"j","kr":"PL","s":59,"st":53,"sl":61,"ag":44,"sj":60,"ct":74},{"id":"falubaz-zielona-gora-7","n":"Mitchell McDiarmid","p":7,"r":"j","kr":"AU","s":55,"st":50,"sl":50,"ag":43,"sj":63,"ct":63},{"id":"falubaz-zielona-gora-8","n":"Michał Curzytek","p":8,"r":"r","kr":"PL","s":48,"st":48,"sl":50,"ag":74,"sj":15,"ct":68}]},{"id":"gkm-grudziadz","n":"GKM Grudziądz","sk":"GRU","m":"Grudziądz","lg":"ekstraliga","b1":"#ffd500","b2":"#1f5aa6","dl":355,"sz":15,"st":"Stadion Miejski w Grudziądzu","z":[{"id":"gkm-grudziadz-1","n":"Max Fricke","p":1,"r":"s","kr":"AU","s":75,"st":79,"sl":81,"ag":59,"sj":30,"ct":75},{"id":"gkm-grudziadz-2","n":"Wadim Tarasienko","p":2,"r":"s","kr":"PL","s":83,"st":88,"sl":78,"ag":51,"sj":45,"ct":74},{"id":"gkm-grudziadz-3","n":"Michael Jepsen Jensen","p":3,"r":"s","kr":"DK","s":86,"st":86,"sl":91,"ag":43,"sj":30,"ct":75},{"id":"gkm-grudziadz-4","n":"Kevin Małkiewicz","p":4,"r":"s","kr":"PL","s":69,"st":65,"sl":65,"ag":74,"sj":58,"ct":71},{"id":"gkm-grudziadz-5","n":"Jan Przanowski","p":5,"r":"s","kr":"PL","s":30,"st":34,"sl":32,"ag":69,"sj":43,"ct":52},{"id":"gkm-grudziadz-6","n":"Damian Miller","p":6,"r":"j","kr":"PL","s":28,"st":28,"sl":33,"ag":44,"sj":67,"ct":60},{"id":"gkm-grudziadz-7","n":"Kacper Szarszewski","p":7,"r":"j","kr":"PL","s":29,"st":34,"sl":29,"ag":57,"sj":34,"ct":52},{"id":"gkm-grudziadz-8","n":"Beau Bailey","p":8,"r":"r","kr":"AU","s":63,"st":64,"sl":66,"ag":72,"sj":29,"ct":66}]},{"id":"wlokniarz-czestochowa","n":"Włókniarz Częstochowa","sk":"CZE","m":"Częstochowa","lg":"ekstraliga","b1":"#ffffff","b2":"#2f7d32","dl":359,"sz":15,"st":"Krono-Plast Arena","z":[{"id":"wlokniarz-czestochowa-1","n":"Jakub Miśkowiak","p":1,"r":"s","kr":"PL","s":73,"st":72,"sl":75,"ag":45,"sj":59,"ct":82},{"id":"wlokniarz-czestochowa-2","n":"Jaimon Lidsey","p":2,"r":"s","kr":"AU","s":69,"st":66,"sl":65,"ag":67,"sj":80,"ct":72},{"id":"wlokniarz-czestochowa-3","n":"Sebastian Szostak","p":3,"r":"s","kr":"PL","s":51,"st":48,"sl":46,"ag":58,"sj":21,"ct":67},{"id":"wlokniarz-czestochowa-4","n":"Kacper Grzelak","p":4,"r":"s","kr":"PL","s":40,"st":43,"sl":43,"ag":48,"sj":13,"ct":68},{"id":"wlokniarz-czestochowa-5","n":"Mads Hansen","p":5,"r":"s","kr":"DK","s":69,"st":73,"sl":67,"ag":73,"sj":65,"ct":70},{"id":"wlokniarz-czestochowa-6","n":"Franciszek Karczewski","p":6,"r":"j","kr":"PL","s":41,"st":36,"sl":41,"ag":65,"sj":66,"ct":60},{"id":"wlokniarz-czestochowa-7","n":"Bartosz Śmigielski","p":7,"r":"j","kr":"PL","s":34,"st":37,"sl":33,"ag":69,"sj":52,"ct":64},{"id":"wlokniarz-czestochowa-8","n":"Szymon Ludwiczak","p":8,"r":"r","kr":"PL","s":51,"st":47,"sl":56,"ag":73,"sj":88,"ct":70}]},{"id":"polonia-bydgoszcz","n":"Polonia Bydgoszcz","sk":"BYD","m":"Bydgoszcz","lg":"1liga","b1":"#ffffff","b2":"#d71920","dl":348,"sz":15,"st":"Stadion Polonii im. Marszałka Józefa Piłsudskiego","z":[{"id":"polonia-bydgoszcz-1","n":"Szymon Woźniak","p":1,"r":"s","kr":"PL","s":75,"st":78,"sl":72,"ag":69,"sj":36,"ct":66},{"id":"polonia-bydgoszcz-2","n":"Krzysztof Buczkowski","p":2,"r":"s","kr":"PL","s":70,"st":75,"sl":75,"ag":48,"sj":17,"ct":70},{"id":"polonia-bydgoszcz-3","n":"Wiktor Przyjemski","p":3,"r":"s","kr":"PL","s":72,"st":79,"sl":74,"ag":76,"sj":84,"ct":68},{"id":"polonia-bydgoszcz-4","n":"Aleksandr Łoktajew","p":4,"r":"s","kr":"UA","s":67,"st":71,"sl":68,"ag":66,"sj":26,"ct":68},{"id":"polonia-bydgoszcz-5","n":"Kai Huckenbeck","p":5,"r":"s","kr":"DE","s":64,"st":58,"sl":64,"ag":42,"sj":59,"ct":77},{"id":"polonia-bydgoszcz-6","n":"Tom Brennan","p":6,"r":"j","kr":"GB","s":47,"st":42,"sl":42,"ag":43,"sj":60,"ct":70},{"id":"polonia-bydgoszcz-7","n":"Kacper Andrzejewski","p":7,"r":"j","kr":"PL","s":52,"st":53,"sl":54,"ag":42,"sj":66,"ct":61},{"id":"polonia-bydgoszcz-8","n":"Maksymilian Pawełczak","p":8,"r":"r","kr":"PL","s":73,"st":77,"sl":70,"ag":59,"sj":29,"ct":74}]},{"id":"psz-poznan","n":"PSŻ Poznań","sk":"POZ","m":"Poznań","lg":"1liga","b1":"#f58220","b2":"#000000","dl":345,"sz":15,"st":"Stadion POSiR Golęcin","z":[{"id":"psz-poznan-1","n":"Bartosz Smektała","p":1,"r":"s","kr":"PL","s":56,"st":62,"sl":55,"ag":60,"sj":67,"ct":62},{"id":"psz-poznan-2","n":"Kacper Pludra","p":2,"r":"s","kr":"PL","s":52,"st":48,"sl":57,"ag":52,"sj":34,"ct":68},{"id":"psz-poznan-3","n":"Niels Kristian Iversen","p":3,"r":"s","kr":"DK","s":56,"st":53,"sl":59,"ag":57,"sj":20,"ct":69},{"id":"psz-poznan-4","n":"Ryan Douglas","p":4,"r":"s","kr":"AU","s":76,"st":73,"sl":76,"ag":56,"sj":56,"ct":81},{"id":"psz-poznan-5","n":"Dimitri Berge","p":5,"r":"s","kr":"FR","s":60,"st":54,"sl":66,"ag":73,"sj":74,"ct":65},{"id":"psz-poznan-6","n":"Antoni Mencel","p":6,"r":"j","kr":"PL","s":53,"st":48,"sl":57,"ag":74,"sj":56,"ct":61},{"id":"psz-poznan-7","n":"Kamil Witkowski","p":7,"r":"j","kr":"PL","s":49,"st":52,"sl":44,"ag":61,"sj":49,"ct":63},{"id":"psz-poznan-8","n":"Stanisław Ignaszak","p":8,"r":"r","kr":"PL","s":28,"st":32,"sl":34,"ag":58,"sj":77,"ct":54}]},{"id":"row-rybnik","n":"ROW Rybnik","sk":"RYB","m":"Rybnik","lg":"1liga","b1":"#1b8f3a","b2":"#000000","dl":357,"sz":15,"st":"Stadion Miejski w Rybniku","z":[{"id":"row-rybnik-1","n":"Nicolai Klindt","p":1,"r":"s","kr":"DK","s":72,"st":78,"sl":76,"ag":50,"sj":68,"ct":78},{"id":"row-rybnik-2","n":"Patryk Wojdyło","p":2,"r":"s","kr":"PL","s":62,"st":58,"sl":59,"ag":54,"sj":44,"ct":74},{"id":"row-rybnik-3","n":"Jakub Jamróg","p":3,"r":"s","kr":"PL","s":61,"st":63,"sl":61,"ag":60,"sj":14,"ct":66},{"id":"row-rybnik-4","n":"Jesper Knudsen","p":4,"r":"s","kr":"DK","s":49,"st":44,"sl":48,"ag":61,"sj":17,"ct":59},{"id":"row-rybnik-5","n":"Jan Kvech","p":5,"r":"s","kr":"CZ","s":74,"st":81,"sl":78,"ag":73,"sj":14,"ct":67},{"id":"row-rybnik-6","n":"Jakub Żurek","p":6,"r":"j","kr":"PL","s":47,"st":51,"sl":43,"ag":52,"sj":19,"ct":66},{"id":"row-rybnik-7","n":"Kacper Tkocz","p":7,"r":"j","kr":"PL","s":40,"st":40,"sl":36,"ag":76,"sj":83,"ct":55},{"id":"row-rybnik-8","n":"Wiktor Lampart","p":8,"r":"r","kr":"PL","s":51,"st":52,"sl":54,"ag":71,"sj":73,"ct":64}]},{"id":"orzel-lodz","n":"Orzeł Łódź","sk":"LOD","m":"Łódź","lg":"1liga","b1":"#1f5aa6","b2":"#ffffff","dl":321,"sz":15,"st":"Moto Arena Łódź","z":[{"id":"orzel-lodz-1","n":"Marcin Nowak","p":1,"r":"s","kr":"PL","s":63,"st":60,"sl":64,"ag":65,"sj":57,"ct":64},{"id":"orzel-lodz-2","n":"Daniel Thompson","p":2,"r":"s","kr":"GB","s":50,"st":52,"sl":55,"ag":56,"sj":47,"ct":58},{"id":"orzel-lodz-3","n":"Zach Cook","p":3,"r":"s","kr":"AU","s":60,"st":65,"sl":64,"ag":54,"sj":20,"ct":73},{"id":"orzel-lodz-4","n":"Szymon Szlauderbach","p":4,"r":"s","kr":"PL","s":56,"st":53,"sl":61,"ag":59,"sj":31,"ct":62},{"id":"orzel-lodz-5","n":"Oliver Berntzon","p":5,"r":"s","kr":"SE","s":58,"st":63,"sl":62,"ag":51,"sj":37,"ct":64},{"id":"orzel-lodz-6","n":"Krzysztof Lewandowski","p":6,"r":"j","kr":"PL","s":37,"st":32,"sl":37,"ag":66,"sj":58,"ct":66},{"id":"orzel-lodz-7","n":"Kacper Halkiewicz","p":7,"r":"j","kr":"PL","s":46,"st":46,"sl":51,"ag":64,"sj":18,"ct":69},{"id":"orzel-lodz-8","n":"Villads Nagel","p":8,"r":"r","kr":"DK","s":61,"st":67,"sl":61,"ag":60,"sj":50,"ct":69}]},{"id":"stal-rzeszow","n":"Stal Rzeszów","sk":"RZE","m":"Rzeszów","lg":"1liga","b1":"#ffffff","b2":"#1f5aa6","dl":395,"sz":15,"st":"Stadion Miejski Stal w Rzeszowie","z":[{"id":"stal-rzeszow-1","n":"Oskar Fajfer","p":1,"r":"s","kr":"PL","s":62,"st":59,"sl":63,"ag":76,"sj":28,"ct":69},{"id":"stal-rzeszow-2","n":"Krzysztof Sadurski","p":2,"r":"s","kr":"PL","s":48,"st":51,"sl":48,"ag":58,"sj":88,"ct":72},{"id":"stal-rzeszow-3","n":"Andreas Lyager","p":3,"r":"s","kr":"DK","s":59,"st":54,"sl":62,"ag":51,"sj":18,"ct":75},{"id":"stal-rzeszow-4","n":"Mateusz Szczepaniak","p":4,"r":"s","kr":"PL","s":59,"st":59,"sl":55,"ag":71,"sj":69,"ct":77},{"id":"stal-rzeszow-5","n":"Josh Pickering","p":5,"r":"s","kr":"AU","s":64,"st":68,"sl":66,"ag":72,"sj":90,"ct":71},{"id":"stal-rzeszow-6","n":"Anders Rowe","p":6,"r":"j","kr":"GB","s":33,"st":34,"sl":37,"ag":64,"sj":73,"ct":58},{"id":"stal-rzeszow-7","n":"Maksym Borowiak","p":7,"r":"j","kr":"PL","s":41,"st":36,"sl":40,"ag":70,"sj":43,"ct":67},{"id":"stal-rzeszow-8","n":"Franciszek Majewski","p":8,"r":"r","kr":"PL","s":43,"st":40,"sl":38,"ag":75,"sj":65,"ct":57}]},{"id":"polonia-pila","n":"Polonia Piła","sk":"PIL","m":"Piła","lg":"1liga","b1":"#d71920","b2":"#ffd500","dl":348,"sz":15,"st":"Asta Arena","z":[{"id":"polonia-pila-1","n":"Benjamin Basso","p":1,"r":"s","kr":"DK","s":61,"st":68,"sl":67,"ag":57,"sj":85,"ct":62},{"id":"polonia-pila-2","n":"Wiktor Jasiński","p":2,"r":"s","kr":"PL","s":53,"st":57,"sl":56,"ag":42,"sj":12,"ct":62},{"id":"polonia-pila-3","n":"Matias Nielsen","p":3,"r":"s","kr":"DK","s":58,"st":63,"sl":56,"ag":45,"sj":46,"ct":63},{"id":"polonia-pila-4","n":"Michał Curzytek","p":4,"r":"s","kr":"PL","s":43,"st":43,"sl":45,"ag":74,"sj":15,"ct":66},{"id":"polonia-pila-5","n":"Andreas Lyager","p":5,"r":"s","kr":"DK","s":59,"st":54,"sl":62,"ag":51,"sj":18,"ct":75},{"id":"polonia-pila-6","n":"Tobiasz Musielak","p":6,"r":"j","kr":"PL","s":63,"st":63,"sl":64,"ag":52,"sj":51,"ct":75},{"id":"polonia-pila-7","n":"Kacper Teska","p":7,"r":"j","kr":"PL","s":51,"st":49,"sl":47,"ag":50,"sj":47,"ct":71},{"id":"polonia-pila-8","n":"Adrian Cyfer","p":8,"r":"r","kr":"PL","s":54,"st":53,"sl":56,"ag":75,"sj":70,"ct":68}]},{"id":"ostrovia-ostrow-wielkopolski","n":"Ostrovia Ostrów Wielkopolski","sk":"OST","m":"Ostrów Wielkopolski","lg":"1liga","b1":"#d71920","b2":"#ffffff","dl":372,"sz":15,"st":"Stadion Miejski w Ostrowie Wielkopolskim","z":[{"id":"ostrovia-ostrow-wielkopolski-1","n":"Frederik Jakobsen","p":1,"r":"s","kr":"DK","s":67,"st":63,"sl":66,"ag":67,"sj":78,"ct":71},{"id":"ostrovia-ostrow-wielkopolski-2","n":"Chris Holder","p":2,"r":"s","kr":"AU","s":51,"st":58,"sl":49,"ag":70,"sj":71,"ct":62},{"id":"ostrovia-ostrow-wielkopolski-3","n":"Gleb Chugunov","p":3,"r":"s","kr":"PL","s":58,"st":64,"sl":64,"ag":76,"sj":67,"ct":67},{"id":"ostrovia-ostrow-wielkopolski-4","n":"Tai Woffinden","p":4,"r":"s","kr":"GB","s":50,"st":54,"sl":56,"ag":57,"sj":61,"ct":68},{"id":"ostrovia-ostrow-wielkopolski-5","n":"Jakub Krawczyk","p":5,"r":"s","kr":"PL","s":52,"st":54,"sl":53,"ag":54,"sj":30,"ct":73},{"id":"ostrovia-ostrow-wielkopolski-6","n":"Jonas Seifert-Salk","p":6,"r":"j","kr":"DK","s":62,"st":57,"sl":61,"ag":46,"sj":51,"ct":62},{"id":"ostrovia-ostrow-wielkopolski-7","n":"Filip Seniuk","p":7,"r":"j","kr":"PL","s":41,"st":38,"sl":45,"ag":65,"sj":47,"ct":65},{"id":"ostrovia-ostrow-wielkopolski-8","n":"Gracjan Szostak","p":8,"r":"r","kr":"PL","s":32,"st":37,"sl":28,"ag":55,"sj":87,"ct":65}]},{"id":"wilki-krosno","n":"Wilki Krosno","sk":"KRO","m":"Krosno","lg":"1liga","b1":"#e31e24","b2":"#000000","dl":398,"sz":15,"st":"Stadion MOSiR Krosno","z":[{"id":"wilki-krosno-1","n":"Marcus Birkemose","p":1,"r":"s","kr":"DK","s":58,"st":63,"sl":63,"ag":66,"sj":53,"ct":70},{"id":"wilki-krosno-2","n":"Jason Doyle","p":2,"r":"s","kr":"AU","s":69,"st":64,"sl":65,"ag":42,"sj":74,"ct":64},{"id":"wilki-krosno-3","n":"Matej Zagar","p":3,"r":"s","kr":"SI","s":67,"st":62,"sl":73,"ag":45,"sj":26,"ct":73},{"id":"wilki-krosno-4","n":"Luke Becker","p":4,"r":"s","kr":"US","s":60,"st":61,"sl":57,"ag":67,"sj":90,"ct":69},{"id":"wilki-krosno-5","n":"Tobiasz Musielak","p":5,"r":"s","kr":"PL","s":63,"st":63,"sl":64,"ag":52,"sj":51,"ct":75},{"id":"wilki-krosno-6","n":"Robert Chmiel","p":6,"r":"j","kr":"PL","s":57,"st":53,"sl":62,"ag":52,"sj":59,"ct":75},{"id":"wilki-krosno-7","n":"Szymon Bańdur","p":7,"r":"j","kr":"PL","s":39,"st":34,"sl":45,"ag":61,"sj":21,"ct":57},{"id":"wilki-krosno-8","n":"Casper Henriksson","p":8,"r":"r","kr":"SE","s":37,"st":33,"sl":33,"ag":72,"sj":77,"ct":57}]},{"id":"wybrzeze-gdansk","n":"Wybrzeże Gdańsk","sk":"GDA","m":"Gdańsk","lg":"2liga","b1":"#d71920","b2":"#ffffff","dl":349,"sz":15,"st":"Stadion im. Zbigniewa Podleckiego","z":[{"id":"wybrzeze-gdansk-1","n":"Mateusz Bartkowiak","p":1,"r":"s","kr":"PL","s":52,"st":59,"sl":49,"ag":55,"sj":76,"ct":69},{"id":"wybrzeze-gdansk-2","n":"Miłosz Wysocki","p":2,"r":"s","kr":"PL","s":48,"st":47,"sl":47,"ag":55,"sj":25,"ct":72},{"id":"wybrzeze-gdansk-3","n":"Krystian Pieszczek","p":3,"r":"s","kr":"PL","s":60,"st":66,"sl":61,"ag":70,"sj":84,"ct":76},{"id":"wybrzeze-gdansk-4","n":"Timo Lahti","p":4,"r":"s","kr":"FI","s":66,"st":71,"sl":69,"ag":57,"sj":41,"ct":78},{"id":"wybrzeze-gdansk-5","n":"Tim Soerensen","p":5,"r":"s","kr":"DK","s":59,"st":62,"sl":59,"ag":63,"sj":36,"ct":76},{"id":"wybrzeze-gdansk-6","n":"Kacper Warduliński","p":6,"r":"j","kr":"PL","s":34,"st":33,"sl":35,"ag":58,"sj":82,"ct":53},{"id":"wybrzeze-gdansk-7","n":"Jan Przanowski","p":7,"r":"j","kr":"PL","s":30,"st":34,"sl":32,"ag":69,"sj":43,"ct":52},{"id":"wybrzeze-gdansk-8","n":"Casper Henriksson","p":8,"r":"r","kr":"SE","s":48,"st":44,"sl":44,"ag":72,"sj":77,"ct":61}]},{"id":"start-gniezno","n":"Start Gniezno","sk":"GNI","m":"Gniezno","lg":"2liga","b1":"#d71920","b2":"#000000","dl":348,"sz":15,"st":"Stadion im. płk. Hynka","z":[{"id":"start-gniezno-1","n":"Norbert Krakowiak","p":1,"r":"s","kr":"PL","s":61,"st":57,"sl":61,"ag":48,"sj":68,"ct":76},{"id":"start-gniezno-2","n":"Kevin Fajfer","p":2,"r":"s","kr":"PL","s":57,"st":60,"sl":63,"ag":45,"sj":84,"ct":75},{"id":"start-gniezno-3","n":"Sam Masters","p":3,"r":"s","kr":"AU","s":68,"st":73,"sl":71,"ag":53,"sj":12,"ct":76},{"id":"start-gniezno-4","n":"Adam Ellis","p":4,"r":"s","kr":"GB","s":64,"st":58,"sl":59,"ag":46,"sj":16,"ct":74},{"id":"start-gniezno-5","n":"Patryk Budniak","p":5,"r":"s","kr":"PL","s":46,"st":49,"sl":42,"ag":70,"sj":20,"ct":65},{"id":"start-gniezno-6","n":"Adrian Saks","p":6,"r":"j","kr":"PL","s":34,"st":37,"sl":39,"ag":52,"sj":55,"ct":58},{"id":"start-gniezno-7","n":"Anže Grmek","p":7,"r":"j","kr":"SI","s":50,"st":54,"sl":49,"ag":59,"sj":66,"ct":74},{"id":"start-gniezno-8","n":"Marcel Juskowiak","p":8,"r":"r","kr":"PL","s":31,"st":25,"sl":29,"ag":71,"sj":22,"ct":55}]},{"id":"kolejarz-opole","n":"Kolejarz Opole","sk":"OPO","m":"Opole","lg":"2liga","b1":"#0057b8","b2":"#ffffff","dl":321,"sz":15,"st":"Stadion Żużlowy im. Mariana Spychały","z":[{"id":"kolejarz-opole-1","n":"Václav Milík","p":1,"r":"s","kr":"CZ","s":64,"st":67,"sl":63,"ag":70,"sj":25,"ct":64},{"id":"kolejarz-opole-2","n":"Oskar Polis","p":2,"r":"s","kr":"PL","s":58,"st":58,"sl":55,"ag":72,"sj":84,"ct":72},{"id":"kolejarz-opole-3","n":"James Pearson","p":3,"r":"s","kr":"AU","s":55,"st":62,"sl":58,"ag":75,"sj":85,"ct":71},{"id":"kolejarz-opole-4","n":"Hubert Łęgowik","p":4,"r":"s","kr":"PL","s":54,"st":60,"sl":59,"ag":59,"sj":87,"ct":69},{"id":"kolejarz-opole-5","n":"Jonas Jeppesen","p":5,"r":"s","kr":"DK","s":59,"st":63,"sl":65,"ag":53,"sj":37,"ct":61},{"id":"kolejarz-opole-6","n":"Oskar Stępień","p":6,"r":"j","kr":"PL","s":33,"st":35,"sl":30,"ag":70,"sj":83,"ct":65},{"id":"kolejarz-opole-7","n":"Oskar Rumiński","p":7,"r":"j","kr":"PL","s":35,"st":37,"sl":35,"ag":68,"sj":75,"ct":53},{"id":"kolejarz-opole-8","n":"Matic Ivačič","p":8,"r":"r","kr":"SI","s":51,"st":50,"sl":52,"ag":57,"sj":18,"ct":71}]},{"id":"speedway-krakow","n":"Speedway Kraków","sk":"KRA","m":"Kraków","lg":"2liga","b1":"#ffd500","b2":"#000000","dl":389,"sz":15,"st":"Stadion Wandy Kraków","z":[{"id":"speedway-krakow-1","n":"Dawid Rempała","p":1,"r":"s","kr":"PL","s":53,"st":52,"sl":49,"ag":55,"sj":58,"ct":74},{"id":"speedway-krakow-2","n":"Kacper Łobodziński","p":2,"r":"s","kr":"PL","s":50,"st":52,"sl":47,"ag":67,"sj":49,"ct":70},{"id":"speedway-krakow-3","n":"Marko Lewiszyn","p":3,"r":"s","kr":"UA","s":62,"st":69,"sl":65,"ag":56,"sj":23,"ct":78},{"id":"speedway-krakow-4","n":"Mitchell Cluff","p":4,"r":"s","kr":"AU","s":49,"st":47,"sl":52,"ag":58,"sj":56,"ct":65},{"id":"speedway-krakow-5","n":"Sebastian Mayland","p":5,"r":"s","kr":"DK","s":47,"st":53,"sl":46,"ag":44,"sj":55,"ct":56},{"id":"speedway-krakow-6","n":"Michael West","p":6,"r":"j","kr":"AU","s":45,"st":41,"sl":44,"ag":62,"sj":56,"ct":72},{"id":"speedway-krakow-7","n":"Stanisław Mielynczuk","p":7,"r":"j","kr":"PL","s":30,"st":25,"sl":25,"ag":56,"sj":70,"ct":50},{"id":"speedway-krakow-8","n":"Dawid Grzeszczyk","p":8,"r":"r","kr":"PL","s":28,"st":26,"sl":26,"ag":50,"sj":20,"ct":51}]},{"id":"slask-swietochlowice","n":"Śląsk Świętochłowice","sk":"SWI","m":"Świętochłowice","lg":"2liga","b1":"#1f5aa6","b2":"#ffffff","dl":370,"sz":15,"st":"Stadion Skałka","z":[{"id":"slask-swietochlowice-1","n":"Kacper Mateusz Grzelak","p":1,"r":"s","kr":"PL","s":50,"st":48,"sl":47,"ag":71,"sj":62,"ct":64},{"id":"slask-swietochlowice-2","n":"Mateusz Tonder","p":2,"r":"s","kr":"PL","s":55,"st":61,"sl":61,"ag":51,"sj":51,"ct":73},{"id":"slask-swietochlowice-3","n":"Adrian Gała","p":3,"r":"s","kr":"PL","s":57,"st":64,"sl":53,"ag":46,"sj":58,"ct":75},{"id":"slask-swietochlowice-4","n":"Wiktor Trofimow","p":4,"r":"s","kr":"PL","s":60,"st":57,"sl":62,"ag":54,"sj":48,"ct":65},{"id":"slask-swietochlowice-5","n":"Bartosz Szymura","p":5,"r":"s","kr":"PL","s":44,"st":41,"sl":49,"ag":55,"sj":22,"ct":62},{"id":"slask-swietochlowice-6","n":"Andriej Rozaliuk","p":6,"r":"j","kr":"UA","s":40,"st":40,"sl":38,"ag":63,"sj":21,"ct":58},{"id":"slask-swietochlowice-7","n":"Bastian Borke","p":7,"r":"j","kr":"DK","s":48,"st":55,"sl":52,"ag":61,"sj":13,"ct":57},{"id":"slask-swietochlowice-8","n":"Jędrzej Chmura","p":8,"r":"r","kr":"PL","s":29,"st":31,"sl":32,"ag":48,"sj":80,"ct":52}]}];
const PROGRAM13 = [{"nr":1,"gosp":[9,12],"gosc":[1,5],"pola":{"1":"B","5":"D","9":"A","12":"C"}},{"nr":2,"gosp":[14,15],"gosc":[6,7],"pola":{"6":"C","7":"A","14":"B","15":"D"}},{"nr":3,"gosp":[11,13],"gosc":[1,2],"pola":{"1":"C","2":"A","11":"D","13":"B"}},{"nr":4,"gosp":[9,12],"gosc":[3,7],"pola":{"3":"D","7":"B","9":"C","12":"A"}},{"nr":5,"gosp":[10,11],"gosc":[2,5],"pola":{"2":"D","5":"B","10":"A","11":"C"}},{"nr":6,"gosp":[12,14],"gosc":[1,3],"pola":{"1":"A","3":"C","12":"B","14":"D"}},{"nr":7,"gosp":[9,10],"gosc":[2,4],"pola":{"2":"C","4":"A","9":"B","10":"D"}},{"nr":8,"gosp":[13,15],"gosc":[3,5],"pola":{"3":"A","5":"C","13":"D","15":"B"}},{"nr":9,"gosp":[9,14],"gosc":[2,4],"pola":{"2":"B","4":"D","9":"C","14":"A"}},{"nr":10,"gosp":[10,11],"gosc":[3,7],"pola":{"3":"B","7":"D","10":"C","11":"A"}},{"nr":11,"gosp":[12,13],"gosc":[4,6],"pola":{"4":"B","6":"D","12":"A","13":"C"}},{"nr":12,"gosp":[11,15],"gosc":[1,5],"pola":{"1":"C","5":"A","11":"B","15":"D"}},{"nr":13,"gosp":[10,13],"gosc":[4,6],"pola":{"4":"C","6":"A","10":"B","13":"D"}}];

/* ======================= STAN GRY ======================= */
const G = {
  wybor: 0, poziom: 1, stanToru: 1, okrazen: 4, tryb: 'bieg', telem: false, zawodnikModel: true, mecz: null, wyborGosp: null, wyborGosc: null,
  jestemGospodarzem: true, przewinienie: null, wykluczonyNumer: null,
  torAktualny: null, torDoPrzebudowy: false, widokKarta: false, klubGosp: null,
  trasaNaj: null, trasaBiez: null, delta: null,
  faza: 'menu',           // menu | prezentacja | podTasma | zielone | jazda | meta | wynik
  t: 0, tFazy: 0, startT: 0, tasma: 0, tasmaCzas: 0,
  bikes: [], surf: null, kamera: 0, kamGracza: 0, kamOdwrocona: false, pauza: false, dzwiek: true, steerSm: 0, jasnosc: 0.58,
  ostrzezenie: false, tknieto: false, wykluczeni: [],
  najlepsza: null, klik: 0
};

/* ======================= WEJŚCIE ======================= */
const KL = {};
const dotyk = { gaz: 0, lewo: 0, prawo: 0, sprzeglo: 0 };
addEventListener('keydown', e => {
  if (e.repeat) return;
  KL[e.code] = 1;
  if (e.code === 'KeyC') { G.kamera = (G.kamera + 1) % 3; G.kamGracza = G.kamera; }
  if (e.code === 'KeyM') {
    G.zawodnikModel = G.zawodnikModel === false;
    pokazKomunikat(G.zawodnikModel ? 'ZAWODNIK Z MODELU' : 'ZAWODNIK Z BRYŁ',
      'zmiana widoczna od następnego biegu', 1800);
  }
  if (e.code === 'Tab') { e.preventDefault(); G.kamOdwrocona = !G.kamOdwrocona; }
  if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    G.jasnosc = clamp(G.jasnosc + (e.code === 'BracketRight' ? 0.06 : -0.06), 0.50, 1.60);
    renderer.toneMappingExposure = G.jasnosc;
    pokazKomunikat('JASNOŚĆ ' + G.jasnosc.toFixed(2), 'klawisze [ oraz ]', 1200);
  }
  if (e.code === 'KeyM') { G.dzwiek = !G.dzwiek; Audio_.wycisz(!G.dzwiek); pokazKomunikat(G.dzwiek ? 'Dźwięk włączony' : 'Wyciszone', '', 900); }
  if (e.code === 'KeyP' && (G.faza === 'jazda' || G.faza === 'meta')) togglePauza();
  if (e.code === 'KeyR' && G.faza !== 'menu') { if (G.faza === 'trening') resetTreningu(); else restartBiegu(); }
  if (e.code === 'KeyT' && G.tryb === 'trening') {
    G.telem = !G.telem; el('telemetria').hidden = !G.telem;
  }
  if (G.faza === 'trening' && (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3')) {
    G.poziom = +e.code.slice(5) - 1;
    const poz = POZIOMY[G.poziom];
    G.gracz.assist = poz.asysta; G.gracz.tol = poz.tol;
    pokazKomunikat(poz.n, 'poziom zmieniony w locie', 1400);
  }
  if (e.code === 'Escape') { if (G.faza !== 'menu') doMenu(); }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
});
addEventListener('keyup', e => { KL[e.code] = 0; });
addEventListener('blur', () => { for (const k in KL) KL[k] = 0; });

function wejscieGracza() {
  const gaz = (KL.KeyW || KL.ArrowUp || dotyk.gaz) ? 1 : 0;
  const stop = (KL.KeyS || KL.ArrowDown) ? 1 : 0;
  const l = (KL.KeyA || KL.ArrowLeft || dotyk.lewo) ? 1 : 0;
  const p = (KL.KeyD || KL.ArrowRight || dotyk.prawo) ? 1 : 0;
  return {
    throttle: stop ? 0 : gaz,
    steer: l - p,                        // + = w lewo (do wnętrza łuku)
    clutch: !!(KL.Space || KL.KeyQ || dotyk.sprzeglo),   // Q na wypadek gubienia kombinacji przez klawiaturę
    ciezar: (KL.ShiftLeft || KL.ShiftRight) ? -1 : 0
  };
}

/* ======================= DŹWIĘK ======================= */
const Audio_ = (() => {
  let ctx = null, master = null, silniki = [], tlo = null, gotowe = false;
  function init() {
    if (gotowe) return; gotowe = true;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    // szum publiczności
    const len = ctx.sampleRate * 2, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.5;
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 620; f.Q.value = 0.6;
    tlo = ctx.createGain(); tlo.gain.value = 0.05;
    src.connect(f); f.connect(tlo); tlo.connect(master); src.start();
  }
  function silnik(glosnosc) {
    if (!ctx) return null;
    const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), o3 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'square'; o3.type = 'sawtooth';
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1400; lp.Q.value = 3.2;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 70;
    const g = ctx.createGain(); g.gain.value = 0;
    const gm = ctx.createGain(); gm.gain.value = glosnosc;
    o1.connect(lp); o2.connect(lp); o3.connect(lp); lp.connect(hp); hp.connect(g); g.connect(gm); gm.connect(master);
    o1.start(); o2.start(); o3.start();
    return { o1, o2, o3, g, lp, gm };
  }
  return {
    start() {
      init(); if (!ctx) return;
      if (ctx.state === 'suspended') ctx.resume();
      silniki.forEach(s => { try { s.o1.stop(); s.o2.stop(); s.o3.stop(); } catch (e) { } });
      silniki = G.bikes.map((b, i) => silnik(b.gracz ? 0.30 : 0.11));
    },
    aktualizuj() {
      if (!ctx || !silniki.length) return;
      G.bikes.forEach((b, i) => {
        const s = silniki[i]; if (!s) return;
        const f = Math.max(b.rpm, 900) / 120;                 // jednocylindrowiec: zapłon co 2 obroty
        s.o1.frequency.setTargetAtTime(f, ctx.currentTime, 0.02);
        s.o2.frequency.setTargetAtTime(f * 2.01, ctx.currentTime, 0.02);
        s.o3.frequency.setTargetAtTime(f * 3.97, ctx.currentTime, 0.03);
        const load = 0.30 + 0.70 * b.thr;
        s.g.gain.setTargetAtTime(b.down > 0 ? 0.02 : 0.055 * load, ctx.currentTime, 0.05);
        s.lp.frequency.setTargetAtTime(500 + 2600 * load + b.spin * 900, ctx.currentTime, 0.05);
      });
      if (tlo) tlo.gain.setTargetAtTime(G.faza === 'jazda' ? 0.075 : 0.045, ctx.currentTime, 0.6);
    },
    pyk(freq, dur, typ) {
      if (!ctx) return;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = typ || 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.12, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
      o.connect(g); g.connect(master); o.start(); o.stop(ctx.currentTime + dur);
    },
    wycisz(m) { if (master) master.gain.setTargetAtTime(m ? 0 : 0.55, ctx.currentTime, 0.05); },
    stop() {
      silniki.forEach(s => { try { s.o1.stop(); s.o2.stop(); s.o3.stop(); } catch (e) { } });
      silniki = [];
      if (tlo && ctx) tlo.gain.setTargetAtTime(0, ctx.currentTime, 0.25);   // gaśnie też szum trybun
    }
  };
})();

/* ======================= SCENA 3D ======================= */
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('scena'), antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = G.jasnosc;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scena = new THREE.Scene();
scena.background = new THREE.Color(0x070b10);
// kopuła nieba z delikatną łuną — bez niej nad trybunami zieje czarna dziura
(function niebo() {
  const c = plotno(4, 256), x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0.00, '#04060a'); g.addColorStop(0.55, '#0a1119');
  g.addColorStop(0.82, '#1b2735'); g.addColorStop(1.00, '#2b3444');
  x.fillStyle = g; x.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding;
  const kopula = new THREE.Mesh(new THREE.SphereGeometry(520, 16, 12),
    new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false, depthWrite: false }));
  kopula.renderOrder = -1;
  scena.add(kopula);
})();
scena.fog = new THREE.Fog(0x121b26, 80, 330);
const kam = new THREE.PerspectiveCamera(62, 1, 0.28, 900);

// pole widzenia zadajemy w poziomie i przeliczamy na pionowe — inaczej przy wąskim
// oknie widać skrawek toru, a przy szerokim obraz robi się nienaturalnie ciasny
function fovZPoziomego(poziomy) {
  const a = Math.max(kam.aspect, 0.30);
  const v = 2 * Math.atan(Math.tan(poziomy * Math.PI / 360) / a) * 180 / Math.PI;
  return clamp(v, 38, 100);
}
function wymiaryOkna() {
  const vv = window.visualViewport;
  return { w: Math.max(1, Math.round(vv ? vv.width : innerWidth)),
           h: Math.max(1, Math.round(vv ? vv.height : innerHeight)) };
}
function skalaHud(w, h) {
  // panele kurczą się razem z oknem, ale nie schodzą poniżej czytelności
  return clamp(Math.min(w / 1180, h / 700), 0.55, 1.25);
}
function dopasujMenu() {
  const m = document.getElementById('menu'), wrap = m && m.querySelector('.wrap');
  if (!wrap || m.hidden) return;
  wrap.style.transform = 'none';
  const cw = wrap.offsetWidth || 1, ch = wrap.offsetHeight || 1;
  const k = Math.min(1, (m.clientWidth - 6) / cw, (m.clientHeight - 6) / ch);
  if (!isFinite(k) || k <= 0) { wrap.style.transform = 'none'; return; }   // przed ułożeniem strony
  wrap.style.transform = 'scale(' + Math.max(k, 0.42).toFixed(4) + ')';
}
function resize() {
  const { w, h } = wymiaryOkna();
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, w * h > 2200000 ? 1.5 : 2));
  renderer.setSize(w, h, false);
  const c = renderer.domElement;
  if (c && c.style) { c.style.width = w + 'px'; c.style.height = h + 'px'; }
  kam.aspect = w / h; kam.updateProjectionMatrix();
  document.documentElement.style.setProperty('--sk', skalaHud(w, h).toFixed(3));
  dopasujMenu();
}
addEventListener('resize', resize);
addEventListener('orientationchange', () => setTimeout(resize, 220));
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', resize);
  window.visualViewport.addEventListener('scroll', resize);
}

/* ---------- światło: mityng pod jupiterami ---------- */
scena.add(new THREE.HemisphereLight(0x3b3a3e, 0x1a120b, 0.44));
const slonce = new THREE.DirectionalLight(0xffefd8, 0.95);
slonce.position.set(48, 96, 40); slonce.castShadow = true;
slonce.shadow.mapSize.set(2048, 2048);
const sc = slonce.shadow.camera;
sc.left = -95; sc.right = 95; sc.top = 95; sc.bottom = -95; sc.near = 20; sc.far = 260;
sc.updateProjectionMatrix();
slonce.shadow.bias = -0.0009; slonce.shadow.normalBias = 0.03;
scena.add(slonce); scena.add(slonce.target);

/* ---------- pomocnicze ---------- */
const M = (o) => new THREE.MeshStandardMaterial(o);
function rura(r1, r2, h, mat, seg) { return new THREE.Mesh(new THREE.CylinderGeometry(r1, r2, h, seg || 10), mat); }
function pudlo(w, h, d, mat) { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); }
function kula(r, mat, s) { return new THREE.Mesh(new THREE.SphereGeometry(r, s || 14, s || 12), mat); }
function plotno(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

/* ---------- NAWIERZCHNIA: tekstura żywego toru ---------- */
const TXW = 1536, TXH = 192;
const cTor = plotno(TXW, TXH), xTor = cTor.getContext('2d');
const cSlady = plotno(TXW, TXH), xSlady = cSlady.getContext('2d');
const cSzum = plotno(TXW, TXH);
(function szum() {
  const x = cSzum.getContext('2d'), im = x.createImageData(TXW, TXH), d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 118 + (Math.random() * 74 - 37) + (Math.random() < 0.045 ? 46 : 0);
    d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
  }
  x.putImageData(im, 0, 0);
})();
const texTor = new THREE.CanvasTexture(cTor);
texTor.wrapS = THREE.RepeatWrapping; texTor.anisotropy = 8; texTor.encoding = THREE.sRGBEncoding;
// Bez tego three.js odwraca płótno w pionie: piksel pisany przy krawężniku lądował
// przy bandzie. Ślad opon wychodził po drugiej stronie toru, a biała linia
// krawężnikowa malowała się pod siatką.
texTor.flipY = false;

// Każdy obiekt ma inną ziemię: jedne tory są rudsze i cieplejsze, inne schodzą
// w szary łupek. Odcień wyliczam z identyfikatora klubu, więc jest stały.
function odcienGospodarza() {
  const k = G.klubGosp;
  if (!k) return { r: 0, g: 0, b: 0 };
  let h = 0; for (let i = 0; i < k.id.length; i++) h = (h * 31 + k.id.charCodeAt(i)) & 0xffff;
  return { r: -14 + (h % 30), g: -9 + ((h >> 4) % 17), b: -11 + ((h >> 8) % 20) };
}
function malujTor() {
  const S = G.surf; if (!S) return;
  const od = odcienGospodarza();
  const cw = TXW / NS, ch = TXH / NL;
  for (let i = 0; i < NS; i++) for (let j = 0; j < NL; j++) {
    const k = i * NL + j;
    const d = Math.min(S.dirt[k], 1), p = S.polish[k], r = S.rut[k];
    // baza łupkowa -> jaśniejsza i luźniejsza tam, gdzie leży ziemia; ciemna i zbita w wyjeżdżonym dołku
    // luźna ziemia jest cieplejsza i jaśniejsza, wyjeżdżony dołek schodzi w zimny grafit
    let R = 118 + 60 * d, Gc = 76 + 42 * d, B = 52 + 30 * d;
    R = lerp(R, 70, p); Gc = lerp(Gc, 64, p); B = lerp(B, 64, p);
    R -= 12 * r; Gc -= 9 * r; B -= 6 * r;
    xTor.fillStyle = `rgb(${clamp(R + od.r, 0, 255) | 0},${clamp(Gc + od.g, 0, 255) | 0},${clamp(B + od.b, 0, 255) | 0})`;
    xTor.fillRect(i * cw - 0.5, j * ch - 0.5, cw + 1, ch + 1);
  }
  // ślady równiarki: pasy w poprzek toru zostawione przy przygotowaniu nawierzchni
  xTor.globalAlpha = 0.15;
  for (let i = 0; i < 320; i++) {
    xTor.fillStyle = i % 2 ? '#000' : '#fff';
    xTor.fillRect(i / 320 * TXW, 0, TXW / 640, TXH);
  }
  xTor.globalAlpha = 0.30; xTor.globalCompositeOperation = 'overlay';
  xTor.drawImage(cSzum, 0, 0);
  xTor.globalCompositeOperation = 'source-over'; xTor.globalAlpha = 1;
  // biała linia przy krawężniku + linia startu/mety + numery pól
  xTor.fillStyle = 'rgba(232,228,218,.62)'; xTor.fillRect(0, 0, TXW, 3);
  const us = TRK.START_S / TRK.L * TXW;
  xTor.fillStyle = 'rgba(240,238,230,.80)'; xTor.fillRect(us - 3, 0, 6, TXH);
  xTor.fillStyle = 'rgba(240,238,230,.34)';
  for (let g = 0; g < 4; g++) {
    const v = (gate(g) + TRK.HW) / (2 * TRK.HW) * TXH;   // rozstaw pól zależy od szerokości toru
    xTor.fillRect(us - 26, v - 1.5, 22, 3);
  }
  xTor.drawImage(cSlady, 0, 0);
  texTor.needsUpdate = true;
}
function sladMotocykla(b) {
  if (b.down > 0) { b._su = undefined; b._fu = undefined; return; }
  // Ślad powstaje pod oponami, nie pod punktem odniesienia motocykla. Osie leżą
  // 0,672 m za nim i 0,812 m przed nim, więc w ślizgu — gdy oś maszyny jest
  // skręcona do kierunku jazdy — tylna opona rysuje wyraźnie z boku od środka.
  const sx = Math.sin(b.psi), cz = Math.cos(b.psi);
  const sl = clamp(Math.abs(b.slipAng) / 0.7, 0, 1);
  const odcisk = (wx, wz, kluczU, kluczV, szer, krycie) => {
    const t = toTrack(wx, wz);
    const u = mod(t.s, TRK.L) / TRK.L * TXW;
    const v = clamp((t.lat + TRK.HW) / (2 * TRK.HW), 0, 1) * TXH;
    const pu = b[kluczU];
    if (pu !== undefined && Math.abs(u - pu) < TXW * 0.5) {
      xSlady.strokeStyle = `rgba(26,20,16,${krycie})`;
      xSlady.lineWidth = szer;
      xSlady.lineCap = 'round';
      xSlady.beginPath(); xSlady.moveTo(pu, b[kluczV]); xSlady.lineTo(u, v); xSlady.stroke();
    }
    b[kluczU] = u; b[kluczV] = v;
  };
  // tylna opona: szeroka smuga, tym mocniejsza im większy ślizg
  odcisk(b.x - sx * 0.672, b.z - cz * 0.672, '_su', '_sv', 1.7 + 2.0 * sl, 0.045 + 0.075 * sl);
  // przednia opona: cienka kreska po torze jazdy
  odcisk(b.x + sx * 0.812, b.z + cz * 0.812, '_fu', '_fv', 1.1, 0.030 + 0.020 * sl);
}


/* ---------- geometria toru ---------- */
function budujTor() {
  const NSG = 288, NLG = 16;
  const g = new THREE.BufferGeometry();
  const pos = [], uv = [], idx = [];
  for (let i = 0; i <= NSG; i++) for (let j = 0; j <= NLG; j++) {
    const s = i / NSG * TRK.L, lat = -TRK.HW + j / NLG * 2 * TRK.HW;
    const p = fromTrack(s, lat);
    pos.push(p.x, surfaceY(s, lat), p.z);
    uv.push(i / NSG, j / NLG);
  }
  const row = NLG + 1;
  for (let i = 0; i < NSG; i++) for (let j = 0; j < NLG; j++) {
    const a = i * row + j, b = a + row;
    // kolejność wierzchołków musi dawać normalne skierowane DO GÓRY —
    // przy odwrotnej tor jest oświetlany od spodu i wychodzi czarny
    idx.push(a, a + 1, b, a + 1, b + 1, b);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  const m = M({ map: texTor, roughness: 0.97, metalness: 0.0 });
  const mesh = new THREE.Mesh(g, m);
  mesh.receiveShadow = true;
  return mesh;
}

/* ---------- STADION ---------- */
function wstega(latOd, latDo, yOd, yDo, mat, seg) {
  const N = seg || 200, g = new THREE.BufferGeometry(), pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const s = i / N * TRK.L;
    const a = fromTrack(s, latOd), b = fromTrack(s, latDo);
    pos.push(a.x, yOd + surfaceY(s, latOd), a.z, b.x, yDo + surfaceY(s, latDo), b.z);
    uv.push(i / N * 26, 0, i / N * 26, 1);
  }
  for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
function texBanda() {
  const c = plotno(1024, 128), x = c.getContext('2d');
  const kolory = ['#16243a', '#7d2b24', '#cfc9ba', '#1d3a2a', '#16243a', '#a8791c', '#141820', '#cfc9ba'];
  let px = 0, i = 0;
  while (px < 1024) {
    const w = 78 + ((i * 53) % 66);
    x.fillStyle = kolory[i % kolory.length]; x.fillRect(px, 0, w, 128);
    x.fillStyle = 'rgba(0,0,0,.20)'; x.fillRect(px, 96, w, 32);
    x.fillStyle = 'rgba(255,255,255,.16)'; x.fillRect(px, 0, w, 5);
    px += w; i++;
  }
  x.fillStyle = 'rgba(0,0,0,.35)'; x.fillRect(0, 0, 1024, 8);
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.encoding = THREE.sRGBEncoding;
  return t;
}
function texSiatka() {
  const c = plotno(64, 64), x = c.getContext('2d');
  x.strokeStyle = 'rgba(190,205,215,.85)'; x.lineWidth = 3;
  for (let i = 0; i <= 64; i += 16) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 64); x.stroke(); x.beginPath(); x.moveTo(0, i); x.lineTo(64, i); x.stroke(); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(140, 3);
  return t;
}
function texKrawez() {
  const c = plotno(256, 32), x = c.getContext('2d');
  for (let i = 0; i < 8; i++) { x.fillStyle = i % 2 ? '#c8392c' : '#eceae2'; x.fillRect(i * 32, 0, 32, 32); }
  const t = new THREE.CanvasTexture(c); t.wrapS = THREE.RepeatWrapping; t.repeat.set(1, 1); t.encoding = THREE.sRGBEncoding;
  return t;
}

function budujStadion(root) {
  // murawa wewnętrzna
  const gPole = new THREE.BufferGeometry(); {
    const pos = [0, -0.02, 0], idx = [];
    const N = 160;
    for (let i = 0; i <= N; i++) { const p = fromTrack(i / N * TRK.L, -TRK.HW - 0.05); pos.push(p.x, -0.02, p.z); }
    for (let i = 1; i <= N; i++) idx.push(0, i, i + 1);
    gPole.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    gPole.setIndex(idx); gPole.computeVertexNormals();
  }
  const murawa = new THREE.Mesh(gPole, M({ color: 0x2f5a1e, roughness: 1 }));
  murawa.receiveShadow = true; root.add(murawa);

  // krawężnik
  const kr = wstega(-TRK.HW - 0.42, -TRK.HW, 0.13, 0.13, M({ map: texKrawez(), roughness: .8 }), 240);
  const kr2 = wstega(-TRK.HW - 0.42, -TRK.HW - 0.42, 0.0, 0.13, M({ color: 0xd8d4c8, roughness: .9 }), 240);
  root.add(kr); root.add(kr2);

  // banda dmuchana + siatka nad nią
  const banda = wstega(TRK.HW + 0.15, TRK.HW + 0.15, 0.0, 1.25, M({ map: texBanda(), roughness: .78, side: THREE.DoubleSide }), 240);
  banda.receiveShadow = true; root.add(banda);
  const gora = wstega(TRK.HW + 0.15, TRK.HW + 0.15, 1.25, 1.42, M({ color: 0x22282f, roughness: .7, side: THREE.DoubleSide }), 240);
  root.add(gora);
  const siatka = wstega(TRK.HW + 0.2, TRK.HW + 0.2, 1.42, 3.5,
    new THREE.MeshBasicMaterial({ map: texSiatka(), transparent: true, opacity: 0.34, side: THREE.DoubleSide, depthWrite: false }), 240);
  root.add(siatka);
  // słupki siatki
  const slupM = M({ color: 0x2b3239, roughness: .6, metalness: .3 });
  for (let i = 0; i < 64; i++) {
    const p = fromTrack(i / 64 * TRK.L, TRK.HW + 0.2);
    const s = rura(0.06, 0.06, 3.6, slupM, 6);
    s.position.set(p.x, 1.8 + surfaceY(i / 64 * TRK.L, TRK.HW + 0.2), p.z); root.add(s);
  }

  // Nazwa miasta co jakiś czas na bandzie — biały napis na tabliczce zwróconej
  // do toru. Płaszczyzna jest obracana przez lookAt, więc tekst nie jest odbity.
  if (G.klubGosp) {
    const c = plotno(512, 96), x = c.getContext('2d');
    x.fillStyle = '#f2f4f6';
    x.font = '700 60px "Barlow Condensed", Arial, sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(G.klubGosp.m.toUpperCase(), 256, 52);
    const tex = new THREE.CanvasTexture(c);
    tex.encoding = THREE.sRGBEncoding;
    const mat = M({ map: tex, transparent: true, roughness: .9, side: THREE.DoubleSide });
    const ILE = 10;
    for (let i = 0; i < ILE; i++) {
      const st = (i + 0.35) / ILE * TRK.L;
      const q = fromTrack(st, TRK.HW + 0.10), sr = fromTrack(st, 0);
      const pl = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 0.58), mat);
      pl.position.set(q.x, surfaceY(st, TRK.HW) + 0.66, q.z);
      pl.lookAt(sr.x, pl.position.y, sr.z);
      root.add(pl);
    }
  }

  // teren za bandą
  const gZ = new THREE.BufferGeometry(); {
    const pos = [], idx = [], N = 160;
    for (let i = 0; i <= N; i++) {
      const s = i / N * TRK.L, a = fromTrack(s, TRK.HW + 0.2), b = fromTrack(s, TRK.HW + 26);
      pos.push(a.x, 0, a.z, b.x, -0.6, b.z);
    }
    for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
    gZ.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); gZ.setIndex(idx); gZ.computeVertexNormals();
  }
  root.add(new THREE.Mesh(gZ, M({ color: 0x171c22, roughness: 1 })));

  // trybuny: schodkowe pierścienie + kibice
  const trybM = M({ color: 0x191e25, roughness: .95 });
  const stopnie = 9;
  for (let k = 0; k < stopnie; k++) {
    const l0 = TRK.HW + 4.0 + k * 1.55, l1 = l0 + 1.55;
    const y = 1.2 + k * 0.92;
    root.add(wstega(l0, l1, y, y, trybM, 150));
    root.add(wstega(l1, l1, y, y + 0.92, M({ color: 0x11161c, roughness: .96 }), 150));
  }
  const ILE = 3600;
  const kibicM = M({ roughness: .95 });   // barwy z instanceColor, nie z atrybutu color
  const glowaM = M({ roughness: .9 });
  const tulowie = new THREE.InstancedMesh(new THREE.BoxGeometry(0.40, 0.62, 0.32), kibicM, ILE);
  const glowy = new THREE.InstancedMesh(new THREE.SphereGeometry(0.115, 6, 5), glowaM, ILE);
  const kolor = new THREE.Color(), skora = new THREE.Color(), dummy = new THREE.Object3D();
  const paleta = [0x141b24, 0x1e2833, 0x3f1d1c, 0x1a3049, 0x5c5850, 0x0f151d, 0x33231a, 0x5e4b21, 0x18342a, 0x242c36];
  const cera = [0x8a6a4e, 0x745036, 0x9c7c5f, 0x574033];
  for (let i = 0; i < ILE; i++) {
    const k = Math.floor(Math.random() * stopnie);
    const st = Math.random() * TRK.L, lat = TRK.HW + 4.6 + k * 1.55 + Math.random() * 0.9;
    const p = fromTrack(st, lat);
    const y = 1.2 + k * 0.92, sk = 0.86 + Math.random() * 0.3;
    const obr = Math.atan2(-p.hx, -p.hz) + (Math.random() - .5) * 0.5;
    dummy.position.set(p.x, y + 0.31 * sk, p.z); dummy.rotation.set(0, obr, 0); dummy.scale.setScalar(sk);
    dummy.updateMatrix(); tulowie.setMatrixAt(i, dummy.matrix);
    dummy.position.set(p.x, y + 0.72 * sk, p.z);
    dummy.updateMatrix(); glowy.setMatrixAt(i, dummy.matrix);
    kolor.setHex(paleta[(Math.random() * paleta.length) | 0]); tulowie.setColorAt(i, kolor);
    skora.setHex(cera[(Math.random() * cera.length) | 0]); glowy.setColorAt(i, skora);
  }
  tulowie.instanceMatrix.needsUpdate = true; glowy.instanceMatrix.needsUpdate = true;
  root.add(tulowie); root.add(glowy);

  Flagi.buduj(root, G.klubGosp);

  // dach nad trybunami
  const dach = wstega(TRK.HW + 5.5, TRK.HW + 19, 11.6, 12.4, M({ color: 0x0d1218, roughness: .95, side: THREE.DoubleSide }), 150);
  root.add(dach);

  // maszty oświetleniowe
  const kratM = M({ color: 0x39424c, roughness: .55, metalness: .55 });
  const lampM = new THREE.MeshBasicMaterial({ color: 0xfff2d4 });
  [[1, 1], [1, -1], [-1, 1], [-1, -1]].forEach(([sx, sz]) => {
    const x = sx * (TRK.S + TRK.R + 20), z = sz * (TRK.R + 20);
    const g = new THREE.Group(); g.position.set(x, 0, z);
    for (let i = 0; i < 4; i++) {
      const s = rura(0.26, 0.34, 26, kratM, 6);
      s.position.set((i % 2 ? 1 : -1) * 0.9, 13, (i < 2 ? 1 : -1) * 0.9); g.add(s);
    }
    for (let i = 0; i < 7; i++) {
      const p = pudlo(2.2, 0.12, 0.12, kratM); p.position.set(0, 2 + i * 3.4, 0.9); g.add(p);
      const q = pudlo(0.12, 0.12, 2.2, kratM); q.position.set(0.9, 2 + i * 3.4, 0); g.add(q);
    }
    const glowa = pudlo(6.4, 3.4, 1.0, M({ color: 0x2b333c, roughness: .6 }));
    glowa.position.set(0, 27.4, 0); glowa.lookAt(0, 8, 0); g.add(glowa);
    for (let a = 0; a < 4; a++) for (let b = 0; b < 2; b++) {
      const l = pudlo(1.3, 1.3, 0.16, lampM);
      l.position.set(-2.4 + a * 1.6, 26.6 + b * 1.5, 0); l.lookAt(0, 6, 0); g.add(l);
    }
    const pl = new THREE.PointLight(0xffeacb, 1.05, 195, 2);
    pl.position.set(x * 0.88, 34, z * 0.88); root.add(pl);
    root.add(g);
  });

  // wieża sędziego
  const wieza = new THREE.Group();
  const wp = fromTrack(TRK.START_S + 8, TRK.HW + 9);
  wieza.position.set(wp.x, 0, wp.z);
  const noga = pudlo(3.2, 8, 3.2, M({ color: 0x232a32, roughness: .9 })); noga.position.y = 4; wieza.add(noga);
  const kab = pudlo(5.0, 2.6, 3.6, M({ color: 0x2e3742, roughness: .7 })); kab.position.y = 9.3; wieza.add(kab);
  const szyba = pudlo(4.6, 1.5, 0.1, new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: .35 }));
  szyba.position.set(0, 9.5, -1.85); wieza.add(szyba);
  wieza.lookAt(0, 0, 0);
  root.add(wieza);
}

/* ---------- MASZYNA STARTOWA (taśma) ---------- */
function budujTasme(root) {
  const grp = new THREE.Group();
  const slupM = M({ color: 0xc9cdd2, roughness: .45, metalness: .5 });
  const s0 = TRK.START_S;
  const stale = new THREE.Group();
  // taśma rozpięta jest tylko między dwoma słupkami na krawędziach toru —
  // między polami startowymi nie stoi nic
  for (const lat of [-TRK.HW - 0.15, TRK.HW + 0.10]) {
    const p = fromTrack(s0, lat);
    const s = rura(0.05, 0.07, 2.4, slupM, 8);
    s.position.set(p.x, 1.2, p.z); s.castShadow = true; stale.add(s);
    const czub = kula(0.08, slupM, 8); czub.position.set(p.x, 2.42, p.z); stale.add(czub);
    const stopa = rura(0.17, 0.20, 0.10, slupM, 10); stopa.position.set(p.x, 0.05, p.z); stale.add(stopa);
  }
  root.add(stale);
  // dwie gumy startowe
  for (const yy of [0.0, 0.30]) {
    const N = 40, pos = [];
    for (let i = 0; i <= N; i++) {
      const lat = -TRK.HW + i / N * 2 * TRK.HW;
      const p = fromTrack(s0, lat);
      pos.push(p.x, yy, p.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xf5f3ec }));
    grp.add(l);
  }
  // grubsza taśma jako pasek
  const N = 48, pos = [], uv = [], idx = [];
  for (let i = 0; i <= N; i++) {
    const lat = -TRK.HW + i / N * 2 * TRK.HW, p = fromTrack(s0, lat);
    pos.push(p.x, 0.045, p.z, p.x, -0.045, p.z);
    uv.push(i / N * 20, 0, i / N * 20, 1);
  }
  for (let i = 0; i < N; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3); }
  const gT = new THREE.BufferGeometry();
  gT.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gT.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gT.setIndex(idx); gT.computeVertexNormals();
  const cT = plotno(64, 16), xT = cT.getContext('2d');
  xT.fillStyle = '#f3f1e8'; xT.fillRect(0, 0, 64, 16);
  xT.fillStyle = '#c8352b'; xT.fillRect(0, 0, 32, 16);
  const tT = new THREE.CanvasTexture(cT); tT.wrapS = THREE.RepeatWrapping;
  grp.add(new THREE.Mesh(gT, M({ map: tT, roughness: .9, side: THREE.DoubleSide })));
  grp.position.y = 0.72;
  grp.userData.s0 = s0;          // pozycja taśmy, po której sprawdzamy zgodność z fizyką
  root.add(grp);

  return grp;
}

/* ---------- POKROWIEC I PŁYTA NAD KIEROWNICĄ ----------
   Pokrowiec to najbardziej rozpoznawalny element żużlowej maszyny: płócienna
   osłona naciągnięta na ramę, z numerem startowym i barwami zawodnika. */
function texPokrowiec(kevlar, pas, numer) {
  const c = plotno(512, 256), x = c.getContext('2d');
  x.fillStyle = kevlar; x.fillRect(0, 0, 512, 256);
  x.fillStyle = '#12151a';
  x.beginPath(); x.moveTo(0, 96); x.lineTo(512, 32); x.lineTo(512, 210); x.lineTo(0, 240); x.closePath(); x.fill();
  x.fillStyle = pas;
  x.beginPath(); x.moveTo(0, 82); x.lineTo(512, 18); x.lineTo(512, 34); x.lineTo(0, 98); x.closePath(); x.fill();
  x.beginPath(); x.moveTo(0, 150); x.lineTo(512, 104); x.lineTo(512, 122); x.lineTo(0, 168); x.closePath(); x.fill();
  // numer startowy na czarnym polu z tyłu pokrowca
  x.fillStyle = '#f2efe6';
  x.font = 'bold 108px "Barlow Condensed", Arial, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(String(numer), 82, 172);
  // wypełniacze udające naszywki sponsorskie (bez prawdziwych marek)
  const plamy = [[196, 186, 74, 22], [286, 190, 58, 20], [360, 178, 66, 22], [232, 132, 52, 16], [318, 126, 44, 16]];
  for (let i = 0; i < plamy.length; i++) {
    const [px, py, pw, ph] = plamy[i];
    x.fillStyle = i % 2 ? 'rgba(240,238,230,.86)' : pas;
    x.fillRect(px, py, pw, ph);
    x.fillStyle = 'rgba(20,22,26,.55)';
    x.fillRect(px + 5, py + ph * 0.34, pw - 10, ph * 0.30);
  }
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
}
// Na kevlarze widnieje nazwisko. Gdy jest dłuższe niż 10 znaków, na plecach
// drukuje się imię — inaczej litery robią się nieczytelne.
function nazwaNaPlecy(pelne) {
  const cz = String(pelne || '').trim().split(/\s+/);
  const nazwisko = cz[cz.length - 1];
  return (nazwisko.length > 10 ? cz[0] : nazwisko).toUpperCase();
}
// Grafika na plecach kevlaru: nazwisko u góry, pod nim wielki numer w ramce.
// Wcześniej były to dwie małe tabliczki, przez co plecy wyglądały na puste.
function texPlecy(tlo, pas, numer, nazwisko) {
  const W = 768, H = 512, c = plotno(W, H), x = c.getContext('2d');
  const rgb = h => [1, 3, 5].map(i => parseInt(String(h).substr(i, 2), 16));
  const [tr, tg, tb] = rgb(tlo);
  const jasneTlo = (0.2126 * tr + 0.7152 * tg + 0.0722 * tb) > 132;
  const atrament = jasneTlo ? '#1b1f26' : '#f4f2ec';
  const cien = jasneTlo ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.45)';
  x.fillStyle = tlo; x.fillRect(0, 0, W, H);
  // szwy kevlaru — delikatne pionowe pasy, żeby materiał nie był płaską plamą
  x.globalAlpha = jasneTlo ? 0.05 : 0.09;
  x.fillStyle = '#000';
  for (const u of [0.16, 0.84]) x.fillRect(u * W - 3, 0, 6, H);
  x.globalAlpha = 1;
  // pas w barwie dodatkowej przez ramiona
  x.fillStyle = pas; x.globalAlpha = 0.85;
  x.fillRect(0, H * 0.055, W, H * 0.045); x.globalAlpha = 1;
  // nazwisko
  x.fillStyle = atrament;
  x.font = '700 84px "Barlow Condensed", Arial Narrow, Arial, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.shadowColor = cien; x.shadowOffsetY = 3; x.shadowBlur = 0;
  x.fillText(nazwisko, W / 2, H * 0.215);
  x.shadowColor = 'transparent';
  // ramka numeru
  const bw = W * 0.46, bh = H * 0.46, bx = (W - bw) / 2, by = H * 0.34;
  x.strokeStyle = atrament; x.lineWidth = 9;
  x.beginPath();
  if (x.roundRect) x.roundRect(bx, by, bw, bh, 16); else x.rect(bx, by, bw, bh);
  x.stroke();
  // numer
  x.fillStyle = atrament;
  x.font = '700 220px "Barlow Condensed", Arial Narrow, Arial, sans-serif';
  x.fillText(String(numer), W / 2, by + bh * 0.54);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
}
// Wygięty płat pleców. Wierzchołki i współrzędne tekstury ustawiam ręcznie, bo
// przy gotowym walcu napis wychodził odbity — u=0 musi trafić na lewą stronę
// zawodnika, którą patrzący od tyłu widzi po swojej lewej.
function platPlecow(mat, szer, wys, rx, rz) {
  const NX = 16, NY = 6, pos = [], uv = [], idx = [];
  for (let j = 0; j <= NY; j++) for (let i = 0; i <= NX; i++) {
    const u = i / NX, v = j / NY, kat = (0.5 - u) * szer;
    pos.push(Math.sin(kat) * rx, v * wys, -Math.cos(kat) * rz);
    uv.push(u, v);
  }
  const row = NX + 1;
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const a = j * row + i;
    idx.push(a, a + 1, a + row, a + 1, a + row + 1, a + row);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return new THREE.Mesh(g, mat);
}
function texNazwisko(tekst, tlo) {
  const c = plotno(512, 128), x = c.getContext('2d');
  x.fillStyle = tlo; x.fillRect(0, 0, 512, 128);
  const r = parseInt(tlo.substr(1, 2), 16), g = parseInt(tlo.substr(3, 2), 16), b = parseInt(tlo.substr(5, 2), 16);
  x.fillStyle = (0.2126 * r + 0.7152 * g + 0.0722 * b) > 140 ? '#14171c' : '#f4f2ec';
  const rozmiar = tekst.length > 9 ? 74 : (tekst.length > 7 ? 88 : 104);
  x.font = `700 ${rozmiar}px "Barlow Condensed", Arial, sans-serif`;
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(tekst, 256, 68);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
}
function texPlyta(kevlar, pas, numer) {
  const c = plotno(256, 128), x = c.getContext('2d');
  x.fillStyle = kevlar; x.fillRect(0, 0, 256, 128);
  x.fillStyle = pas; x.fillRect(0, 0, 256, 16); x.fillRect(0, 112, 256, 16);
  x.fillStyle = '#f2efe6';
  x.font = 'bold 68px "Barlow Condensed", Arial, sans-serif';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(String(numer), 128, 66);
  const t = new THREE.CanvasTexture(c); t.encoding = THREE.sRGBEncoding; return t;
}
// ExtrudeGeometry nadaje UV w jednostkach kształtu — normalizujemy do 0..1
function normalizujUV(g) {
  const uv = g.attributes.uv; if (!uv) return g;
  let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    if (u < u0) u0 = u; if (u > u1) u1 = u; if (v < v0) v0 = v; if (v > v1) v1 = v;
  }
  const du = (u1 - u0) || 1, dv = (v1 - v0) || 1;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (uv.getX(i) - u0) / du, (uv.getY(i) - v0) / dv);
  uv.needsUpdate = true; return g;
}
// bryła powstała z obrysu w płaszczyźnie (z, y), wyciągnięta na boki
function zObrysu(punkty, szer) {
  const sh = new THREE.Shape();
  sh.moveTo(punkty[0][0], punkty[0][1]);
  for (let i = 1; i < punkty.length; i++) sh.lineTo(punkty[i][0], punkty[i][1]);
  sh.closePath();
  const g = new THREE.ExtrudeGeometry(sh, { depth: szer, bevelEnabled: false, curveSegments: 4 });
  normalizujUV(g);
  g.rotateY(-Math.PI / 2);
  g.translate(szer / 2, 0, 0);
  g.computeVertexNormals();
  return g;
}

const _cacheObrys = {};
function zObrusuCache(punkty, szer) {
  const klucz = punkty.length + ':' + szer;
  return _cacheObrys[klucz] || (_cacheObrys[klucz] = zObrysu(punkty, szer));
}

/* ---------- SZKIELET ZAWODNIKA: ogniwa i staw dwuogniwowy ---------- */
const OS_Y = new THREE.Vector3(0, 1, 0);
const _kier = new THREE.Vector3();
const _staw = { x: 0, y: 0, z: 0 }, _cel = { x: 0, y: 0, z: 0 };
const _mx = new THREE.Matrix4(), _vx = new THREE.Vector3(), _vy = new THREE.Vector3(), _vz = new THREE.Vector3();

// ustawia obiekt tak, by jego +Z celowało w (zx,zy,zz), a +Y było jak najbliżej (yx,yy,yz)
function ustawOs(o, px, py, pz, zx, zy, zz, yx, yy, yz) {
  _vz.set(zx, zy, zz).normalize();
  _vy.set(yx, yy, yz);
  _vx.crossVectors(_vy, _vz);
  if (_vx.lengthSq() < 1e-8) _vx.set(1, 0, 0);
  _vx.normalize();
  _vy.crossVectors(_vz, _vx).normalize();
  _mx.makeBasis(_vx, _vy, _vz);
  o.position.set(px, py, pz);
  o.quaternion.setFromRotationMatrix(_mx);
}

// ustawia walec tak, by biegł od punktu A do B (skala wzdłuż osi zachowuje przekrój)
function ustawOgniwo(m, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l = Math.hypot(dx, dy, dz) || 1e-5;
  m.position.set(ax, ay, az);
  _kier.set(dx / l, dy / l, dz / l);
  m.quaternion.setFromUnitVectors(OS_Y, _kier);
  m.scale.set(1, l / m.userData.dl0, 1);
}
// pozycja łokcia/kolana; biegun (px,py,pz) wyznacza stronę zgięcia.
// Zwraca _staw, a przycięty do zasięgu cel zostawia w _cel.
function staw(ax, ay, az, bx, by, bz, l1, l2, px, py, pz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const raw = Math.hypot(dx, dy, dz) || 1e-5;
  const ux = dx / raw, uy = dy / raw, uz = dz / raw;
  const dd = clamp(raw, Math.abs(l1 - l2) + 0.02, l1 + l2 - 0.01);
  _cel.x = ax + ux * dd; _cel.y = ay + uy * dd; _cel.z = az + uz * dd;
  const a = (l1 * l1 - l2 * l2 + dd * dd) / (2 * dd);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const pd = px * ux + py * uy + pz * uz;
  let nx = px - ux * pd, ny = py - uy * pd, nz = pz - uz * pd;
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-5) { nx = -ux * uy; ny = 1 - uy * uy; nz = -uz * uy; nl = Math.hypot(nx, ny, nz) || 1; }
  nx /= nl; ny /= nl; nz /= nl;
  _staw.x = ax + ux * a + nx * h; _staw.y = ay + uy * a + ny * h; _staw.z = az + uz * a + nz * h;
  return _staw;
}

const texOpona = (() => {
  const c = plotno(128, 32), x = c.getContext('2d');
  x.fillStyle = '#141619'; x.fillRect(0, 0, 128, 32);
  x.fillStyle = '#282d33';
  for (let i = 0; i < 8; i++) { x.fillRect(i * 16 + 2, 1, 10, 13); x.fillRect(i * 16 + 9, 18, 10, 13); }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(5, 1);
  t.encoding = THREE.sRGBEncoding; return t;
})();

// Rura poprowadzona od punktu A do B. Wcześniej liczyłem kąty Eulera ręcznie
// i pomyliłem znaki: widelec sterczał w górę zamiast schodzić do osi koła,
// a cylinder pochylał się do tyłu. Tu kierunek wynika wprost z wektora.
function rurkaAB(ax, ay, az, bx, by, bz, r, mat, seg) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const l = Math.hypot(dx, dy, dz) || 1e-5;
  const m = rura(r, r, l, mat, seg || 7);
  m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
  m.quaternion.setFromUnitVectors(OS_Y, new THREE.Vector3(dx / l, dy / l, dz / l));
  return m;
}

function budujMotocykl(z) {
  z.numer = z.numer || 1;
  const kaskKol = new THREE.Color(z.kask), kevlar = new THREE.Color(z.kevlar), pas = new THREE.Color(z.pas);
  const mRama = M({ color: 0xb9c0c8, roughness: .40, metalness: .70 });
  const mCzarny = M({ color: 0x15181c, roughness: .70 });
  const mSilnik = M({ color: 0x9aa2aa, roughness: .45, metalness: .65 });
  const mChrom = M({ color: 0xdde4ea, roughness: .22, metalness: .90 });
  const mOpona = M({ map: texOpona, roughness: .95 });
  const mKevlar = M({ color: kevlar, roughness: .58 });
  const mPas = M({ color: pas, roughness: .55 });
  const mKask = M({ color: kaskKol, roughness: .34 });
  const mCien = M({ color: kevlar.clone().multiplyScalar(0.52), roughness: .62 });
  const mRek = M({ color: 0xe7e4dc, roughness: .62 });
  const mBut = M({ color: 0x14171a, roughness: .58 });
  const mStal = M({ color: 0xc3ccd4, roughness: .28, metalness: .85 });

  const root = new THREE.Group();
  const przechyl = new THREE.Group(); root.add(przechyl);
  const mot = new THREE.Group(); przechyl.add(mot);

  // ===================================================================
  //  Geometria z przysłanego modelu (motocykl_zuzlowy_threejs_v3.js).
  //  Tam: X wzdłuż, Y w górę, Z w bok. Tutaj: Z wzdłuż, X w lewo, Y w górę.
  //  Skala K=0.70 sprowadza rozstaw osi 2,12 m do 1,48 m.
  //  Szprychy i bieżnik idą przez InstancedMesh — w oryginale to 96 siatek.
  // ===================================================================
  const K = 0.70;
  const mJasny = M({ color: 0xd7d9dc, roughness: .66, metalness: .05 });
  const mKorpus = M({ map: texPokrowiec(z.kevlar, z.pas, z.numer), roughness: .70, side: THREE.DoubleSide });
  const mTablica = M({ map: texPlyta(z.kevlar, z.pas, z.numer), roughness: .70, side: THREE.DoubleSide });
  const OSKR = new THREE.Vector3(0, 1.13 * K, 0.775 * K);      // oś skrętu = główka ramy

  // punkt modelu (wzdłuż, wysokość, bok) -> układ gry
  const Pm = (dl, wy, bo) => new THREE.Vector3((bo || 0) * K, wy * K, dl * K);
  const Pf = (dl, wy, bo) => Pm(dl, wy, bo).sub(OSKR);          // to samo, ale względem osi skrętu

  function rurkaP(a, b, r, mat, seg, rodzic) {
    const d = new THREE.Vector3().subVectors(b, a), l = d.length();
    const m = rura(r, r, l, mat, seg || 8);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    m.quaternion.setFromUnitVectors(OS_Y, d.normalize());
    (rodzic || mot).add(m); return m;
  }
  // obrys w płaszczyźnie (wzdłuż, wysokość) wyciągany na boki
  function panel(punkty, gr, mat, faza) {
    const sh = new THREE.Shape();
    sh.moveTo(punkty[0][0] * K, punkty[0][1] * K);
    for (let i = 1; i < punkty.length; i++) sh.lineTo(punkty[i][0] * K, punkty[i][1] * K);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: gr * K, steps: 1, bevelEnabled: faza > 0,
      bevelSegments: 2, bevelSize: faza * K, bevelThickness: faza * K * 0.75, curveSegments: 6 });
    g.translate(0, 0, -gr * K / 2);
    normalizujUV(g); g.rotateY(-Math.PI / 2); g.computeVertexNormals();
    return new THREE.Mesh(g, mat);
  }

  function koloZ(nazwa) {
    const g = new THREE.Group();
    const R = 0.43 * K;
    const op = new THREE.Mesh(new THREE.TorusGeometry(R, 0.038 * K, 8, 26), mOpona);
    op.rotation.y = Math.PI / 2; g.add(op);
    const obr = new THREE.Mesh(new THREE.TorusGeometry(R - 0.046 * K, 0.010 * K, 6, 26), mChrom);
    obr.rotation.y = Math.PI / 2; g.add(obr);
    const piasta = rura(0.044 * K, 0.044 * K, 0.12 * K, mChrom, 14);
    piasta.rotation.z = Math.PI / 2; g.add(piasta);
    // szprychy: jedna siatka na całe koło
    const dlSz = (0.43 - 0.06) * K;
    const gSz = new THREE.CylinderGeometry(0.0024 * K, 0.0024 * K, dlSz, 4);
    const szpr = new THREE.InstancedMesh(gSz, mChrom, 32);
    const d1 = new THREE.Object3D();
    for (let i = 0; i < 32; i++) {
      const bok = (i % 2 ? 1 : -1) * 0.038 * K, kat = (i / 32) * Math.PI * 2;
      d1.position.set(bok, Math.cos(kat) * dlSz / 2, Math.sin(kat) * dlSz / 2);
      d1.rotation.set(kat, 0, 0); d1.updateMatrix(); szpr.setMatrixAt(i, d1.matrix);
    }
    szpr.instanceMatrix.needsUpdate = true; g.add(szpr);
    // bieżnik: klocki po obwodzie, też jedną siatką
    const Rt = R + 0.038 * K;
    const gBz = new THREE.BoxGeometry(0.115 * K, 0.020 * K, 0.052 * K);
    const bz = new THREE.InstancedMesh(gBz, mOpona, 40);
    for (let i = 0; i < 40; i++) {
      const kat = (i / 40) * Math.PI * 2;
      d1.position.set(0, Math.cos(kat) * Rt, Math.sin(kat) * Rt);
      d1.rotation.set(kat, 0, 0); d1.updateMatrix(); bz.setMatrixAt(i, d1.matrix);
    }
    bz.instanceMatrix.needsUpdate = true; g.add(bz);
    g.name = nazwa; return g;
  }

  const tyl = koloZ('tyl'); tyl.position.copy(Pm(-0.96, 0.48)); mot.add(tyl);
  // zębatka z otworami
  const ksz = new THREE.Shape(); ksz.absarc(0, 0, 0.145 * K, 0, Math.PI * 2, false);
  const otw = new THREE.Path(); otw.absarc(0, 0, 0.035 * K, 0, Math.PI * 2, true); ksz.holes.push(otw);
  for (let i = 0; i < 8; i++) {
    const kat = i / 8 * Math.PI * 2, h = new THREE.Path();
    h.absarc(0.085 * K * Math.cos(kat), 0.085 * K * Math.sin(kat), 0.022 * K, 0, Math.PI * 2, true);
    ksz.holes.push(h);
  }
  const gZeb = new THREE.ExtrudeGeometry(ksz, { depth: 0.014 * K, bevelEnabled: false, curveSegments: 10 });
  gZeb.translate(0, 0, -0.007 * K); gZeb.rotateY(Math.PI / 2);
  const zebatka = new THREE.Mesh(gZeb, mChrom); zebatka.position.x = 0.105 * K; tyl.add(zebatka);

  // --- zespół kierowany ---
  const przod = new THREE.Group(); przod.position.copy(OSKR); mot.add(przod);
  const przodK = koloZ('przod'); przodK.position.copy(Pf(1.16, 0.48)); przod.add(przodK);
  for (const bo of [-0.065, 0.065]) {
    rurkaP(Pf(0.77, 1.13, bo), Pf(1.16, 0.48, bo), 0.019 * K, mChrom, 8, przod);
    for (let i = 0; i < 3; i++) {
      const t = 0.50 + i * 0.075;
      const pkt = Pf(0.77, 1.13, bo).lerp(Pf(1.16, 0.48, bo), t);
      const pier = rura(0.030 * K, 0.030 * K, 0.026 * K, mSilnik, 12);
      pier.position.copy(pkt); pier.rotation.x = Math.atan2(0.39, -0.65);   // oś gumy wzdłuż goleni
      przod.add(pier);
    }
  }
  // tablica numerowa w poprzek, przodem do kierunku jazdy
  const tsz = new THREE.Shape();
  tsz.moveTo(-0.43 * K, 0.15 * K); tsz.lineTo(-0.34 * K, 0.34 * K);
  tsz.quadraticCurveTo(-0.18 * K, 0.40 * K, 0, 0.36 * K);
  tsz.quadraticCurveTo(0.18 * K, 0.40 * K, 0.34 * K, 0.34 * K);
  tsz.lineTo(0.43 * K, 0.15 * K); tsz.lineTo(0.22 * K, 0.08 * K);
  tsz.lineTo(0.13 * K, -0.22 * K); tsz.lineTo(-0.13 * K, -0.22 * K);
  tsz.lineTo(-0.22 * K, 0.08 * K); tsz.closePath();
  const gTab = new THREE.ExtrudeGeometry(tsz, { depth: 0.055 * K, steps: 1, bevelEnabled: true,
    bevelSegments: 2, bevelSize: 0.010 * K, bevelThickness: 0.008 * K, curveSegments: 8 });
  gTab.translate(0, 0, -0.0275 * K); normalizujUV(gTab);
  const tablica = new THREE.Mesh(gTab, mTablica);
  tablica.position.copy(Pf(0.78, 1.23)); przod.add(tablica);
  // błotnik przedni jako łuk nad oponą
  const luk = new THREE.CatmullRomCurve3([Pf(0.94, 0.78, -0.06), Pf(1.07, 0.86, 0), Pf(1.20, 0.79, 0.06)]);
  przod.add(new THREE.Mesh(new THREE.TubeGeometry(luk, 16, 0.018 * K, 6, false), mJasny));
  // kierownica
  rurkaP(Pf(0.78, 1.47), Pf(0.78, 1.56), 0.014 * K, mChrom, 7, przod);
  rurkaP(Pf(0.78, 1.55, -0.25), Pf(0.78, 1.55, 0.25), 0.013 * K, mChrom, 7, przod);
  for (const sg of [-1, 1]) {
    rurkaP(Pf(0.78, 1.55, sg * 0.25), Pf(0.75, 1.54, sg * 0.38), 0.013 * K, mChrom, 6, przod);
    rurkaP(Pf(0.75, 1.54, sg * 0.38), Pf(0.74, 1.54, sg * 0.49), 0.020 * K, mCzarny, 8, przod);
  }
  const kab = new THREE.CatmullRomCurve3([Pf(0.75, 1.50, -0.10), Pf(0.62, 1.45, -0.08), Pf(0.54, 1.26, -0.06)]);
  przod.add(new THREE.Mesh(new THREE.TubeGeometry(kab, 10, 0.003 * K, 5, false), mSilnik));

  // --- korpus: szeroki, zwężający się panel z numerem ---
  mot.add(panel([[0.72, 1.40], [0.44, 1.29], [0.10, 1.12], [-0.30, 0.94], [-0.67, 0.82],
                 [-0.72, 0.60], [-0.44, 0.52], [-0.05, 0.56], [0.34, 0.70], [0.62, 0.93]],
                0.16, mKorpus, 0.018));
  // tylny błotnik i osłona łańcucha
  mot.add(panel([[-0.50, 1.03], [-1.00, 1.03], [-1.04, 0.98], [-1.00, 0.91], [-0.50, 0.92]],
                0.18, mJasny, 0.012));
  const oslL = panel([[-0.18, 0.78], [-0.40, 0.68], [-0.65, 0.58], [-0.89, 0.48],
                      [-0.92, 0.40], [-0.78, 0.42], [-0.55, 0.49], [-0.30, 0.61], [-0.10, 0.70]],
                     0.035, mJasny, 0.010);
  oslL.position.x = 0.12 * K; mot.add(oslL);

  // --- rama ---
  for (const bo of [-0.075, 0.075]) {
    rurkaP(Pm(0.63, 1.25, bo), Pm(0.00, 1.03, bo), 0.014 * K, mRama, 6);
    rurkaP(Pm(0.00, 1.03, bo), Pm(-0.52, 0.78, bo), 0.013 * K, mRama, 6);
    rurkaP(Pm(-0.52, 0.78, bo), Pm(-0.90, 0.49, bo), 0.013 * K, mRama, 6);
    rurkaP(Pm(0.55, 0.94, bo), Pm(0.14, 0.46, bo), 0.013 * K, mRama, 6);
    rurkaP(Pm(0.14, 0.46, bo), Pm(-0.56, 0.50, bo), 0.012 * K, mRama, 6);
    rurkaP(Pm(-0.56, 0.50, bo), Pm(-0.94, 0.48, bo), 0.015 * K, mRama, 6);
  }
  rurkaP(Pm(-0.52, 0.78, -0.075), Pm(-0.52, 0.78, 0.075), 0.012 * K, mRama, 6);
  for (const sg of [-1, 1]) {
    rurkaP(Pm(-0.97, 0.82, sg * 0.12), Pm(-1.00, 1.00, sg * 0.12), 0.011 * K, mChrom, 6);
  }
  rurkaP(Pm(-1.00, 1.00, -0.12), Pm(-1.00, 1.00, 0.12), 0.011 * K, mChrom, 6);

  // --- siodło ---
  const siodlo = kula(1, mCzarny, 14);
  siodlo.scale.set(0.18 * K, 0.085 * K, 0.28 * K);
  siodlo.position.copy(Pm(-0.23, 1.12)); siodlo.rotation.x = 0.04; mot.add(siodlo);

  // --- silnik ---
  const kart = kula(1, mSilnik, 14);
  kart.scale.set(0.14 * K, 0.16 * K, 0.23 * K); kart.position.copy(Pm(-0.02, 0.47)); mot.add(kart);
  const skrz = kula(1, mSilnik, 12);
  skrz.scale.set(0.15 * K, 0.12 * K, 0.14 * K); skrz.position.copy(Pm(0.16, 0.45)); mot.add(skrz);
  for (const bo of [-0.145, 0.145]) {
    const pok = rura(0.13 * K, 0.13 * K, 0.025 * K, mJasny, 16);
    pok.rotation.z = Math.PI / 2; pok.position.copy(Pm(0.10, 0.46, bo)); mot.add(pok);
  }
  // cylinder: stos żeber wzdłuż pochylonej osi
  const gCyl = new THREE.Group();
  gCyl.position.copy(Pm(0.15, 0.57)); gCyl.rotation.x = 0.72; mot.add(gCyl);
  for (let i = 0; i < 7; i++) {
    const zeb = rura((0.13 - i * 0.003) * K, (0.13 - i * 0.003) * K, 0.018 * K, mSilnik, 14);
    zeb.scale.x = 0.78; zeb.position.y = i * 0.036 * K; gCyl.add(zeb);
  }
  const glow = rura(0.115 * K, 0.125 * K, 0.12 * K, mChrom, 12);
  glow.scale.x = 0.82; glow.position.y = 0.30 * K; gCyl.add(glow);

  // --- wydech ---
  const wyd = new THREE.CatmullRomCurve3([Pm(0.29, 0.64, 0.14), Pm(0.25, 0.48, 0.16),
    Pm(0.05, 0.33, 0.17), Pm(-0.38, 0.27, 0.18), Pm(-0.64, 0.27, 0.18)]);
  mot.add(new THREE.Mesh(new THREE.TubeGeometry(wyd, 26, 0.022 * K, 8, false), mChrom));
  const tlum = rura(0.075 * K, 0.070 * K, 0.48 * K, mSilnik, 12);
  tlum.rotation.x = Math.PI / 2; tlum.position.copy(Pm(-0.75, 0.27, 0.18)); mot.add(tlum);

  // --- napęd i drobiazgi ---
  const zebP = rura(0.072 * K, 0.072 * K, 0.018 * K, mChrom, 14);
  zebP.rotation.z = Math.PI / 2; zebP.position.copy(Pm(-0.18, 0.47, 0.105)); mot.add(zebP);
  rurkaP(Pm(-0.18, 0.535, 0.11), Pm(-0.96, 0.610, 0.11), 0.007 * K, mSilnik, 5);
  rurkaP(Pm(-0.18, 0.405, 0.11), Pm(-0.96, 0.350, 0.11), 0.007 * K, mSilnik, 5);
  rurkaP(Pm(-0.22, 0.43, -0.16), Pm(-0.22, 0.43, 0.19), 0.008 * K, mSilnik, 6);

  /* ================== ZAWODNIK ==================
     Sylwetka budowana z brył o gładkim cieniowaniu: tułów jako profil obrotowy
     zwężony w talii i spłaszczony z przodu do tyłu, kończyny stożkowe z kulami
     w stawach o dopasowanym promieniu — dzięki temu nie ma szpar ani uskoków.
     Materiały są rozdzielone: kevlar, ciemne panele boczne, ochraniacze,
     rękawice, buty i stal. Wcześniej wszystko było jednym białym walcem. */
  const CZ = {};
  const SEG = 14;                                   // gładkość kończyn
  function ogniwo(r1, r2, dl, mat) {
    const g = new THREE.CylinderGeometry(r1, r2, dl, SEG, 1, false);
    g.translate(0, dl / 2, 0);
    const m = new THREE.Mesh(g, mat); m.userData.dl0 = dl; return m;
  }
  const kulaS = (r, mat, sx, sy, sz) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), mat);
    if (sx !== undefined) m.scale.set(sx, sy, sz);
    return m;
  };

  const mKevlarC = M({ color: kevlar.clone().multiplyScalar(0.62), roughness: .64 });
  const mOchr = M({ color: 0x1a1d22, roughness: .52 });        // ochraniacze i kołnierz
  const mGogle = M({ color: 0x0e1116, roughness: .38 });
  const mSzklo = M({ color: 0xcf9a34, roughness: .12, metalness: .78 });

  const TUL = 0.50;
  const tulow = new THREE.Group(); mot.add(tulow); CZ.tulow = tulow;

  // Korpus: profil obrotowy rozszerzony w barkach i spłaszczony z przodu do tyłu.
  // Od tyłu żużlowiec jest szeroki i niski, nie jest smukłym walcem — dlatego
  // skala X jest większa od Z, a barki wchodzą w obrys tułowia zamiast sterczeć.
  const profil = [
    [0.030, 0.000], [0.136, 0.014], [0.154, 0.048], [0.150, 0.125],
    [0.160, 0.195], [0.178, 0.280], [0.192, 0.355], [0.196, 0.420],
    [0.180, 0.455], [0.146, 0.482], [0.096, 0.502], [0.074, 0.514]
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const korpus = new THREE.Mesh(new THREE.LatheGeometry(profil, 22), mKevlar);
  korpus.scale.set(1.10, 1, 0.68); tulow.add(korpus);

  // Plecy: jeden duży płat z nazwiskiem i numerem. Zastąpił małą tabliczkę
  // i osobny pasek z nazwiskiem, które ginęły na tle kombinezonu.
  const plecy = platPlecow(
    M({ map: texPlecy(z.kevlar, z.pas, z.numer, nazwaNaPlecy(z.nazwa)), roughness: .64, side: THREE.DoubleSide }),
    2.45, 0.330, 0.213, 0.139);
  plecy.position.y = 0.140; tulow.add(plecy);

  const pasek = rura(0.160, 0.152, 0.070, mPas, 18); pasek.position.y = 0.120;
  pasek.scale.set(1.10, 1, 0.70); tulow.add(pasek);
  const miednica = kulaS(0.158, mKevlarC, 1.10, 0.58, 0.76); miednica.position.y = 0.050; tulow.add(miednica);

  // Barki wtopione w tułów: spłaszczone i przysunięte, wychodzi z nich ramię.
  for (const sg of [-1, 1]) {
    const bark = kulaS(0.078, mKevlar, 1.05, 0.92, 0.90);
    bark.position.set(sg * 0.136, 0.428, -0.008); tulow.add(bark);
  }
  // szyja i kołnierz ochronny — bez nich głowa wisiała w powietrzu
  const szyja = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.070, 0.105, 12), M({ color: 0x8f7358, roughness: .74 }));
  szyja.position.y = 0.515; tulow.add(szyja);
  // Kołnierz zszedł do wąskiej lamówki przy samym kombinezonie — poprzedni,
  // gruby torus tworzył przy karku bryłę, która psuła całą sylwetkę od tyłu.
  const kolnierz = new THREE.Mesh(new THREE.TorusGeometry(0.072, 0.016, 6, 16), mOchr);
  kolnierz.position.y = 0.492; kolnierz.rotation.x = Math.PI / 2; tulow.add(kolnierz);

  // ---------- głowa ----------
  const glowa = new THREE.Group(); mot.add(glowa); CZ.glowa = glowa;
  const mSkorupa = M({ color: 0xeceae4, roughness: .32 });
  const skorupa = kulaS(0.140, mSkorupa, 0.96, 1.00, 1.08); glowa.add(skorupa);
  // pałąk podbródkowy: wycinek torusa daje kształt kasku pełnego
  const palak = new THREE.Mesh(new THREE.TorusGeometry(0.118, 0.046, 8, 16, Math.PI * 1.05), mSkorupa);
  palak.position.set(0, -0.052, 0.020); palak.rotation.set(Math.PI / 2, 0, -Math.PI * 0.52);
  palak.scale.set(1, 1, 0.92); glowa.add(palak);
  // pokrowiec w barwie pola startowego — czasza z wycinka kuli
  const pokrywa = new THREE.Mesh(
    new THREE.SphereGeometry(0.148, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.56), mKask);
  pokrywa.scale.set(0.96, 1.00, 1.08); pokrywa.rotation.x = -0.34; glowa.add(pokrywa);
  const ogon = kulaS(0.075, mKask, 1.0, 0.72, 1.05); ogon.position.set(0, 0.026, -0.126); glowa.add(ogon);
  // gogle: pasek wokół kasku + wypukłe szkło
  const pasG = new THREE.Mesh(new THREE.TorusGeometry(0.140, 0.021, 6, 20), mGogle);
  pasG.position.set(0, 0.014, 0.004); pasG.rotation.set(1.30, 0, 0); pasG.scale.set(1.0, 1.0, 0.94); glowa.add(pasG);
  const ramkaG = kulaS(0.098, mGogle, 1.02, 0.52, 0.42); ramkaG.position.set(0, 0.014, 0.098); glowa.add(ramkaG);
  const szkloG = kulaS(0.086, mSzklo, 1.0, 0.42, 0.40); szkloG.position.set(0, 0.016, 0.116); glowa.add(szkloG);
  const daszek = new THREE.Mesh(new THREE.BoxGeometry(0.190, 0.020, 0.092), mKask);
  daszek.position.set(0, 0.096, 0.120); daszek.rotation.x = 0.38; glowa.add(daszek);

  // ---------- kończyny ----------
  CZ.ramie = {}; CZ.przedr = {}; CZ.dlon = {}; CZ.lokiec = {};
  CZ.udo = {}; CZ.lydka = {}; CZ.but = {}; CZ.kolano = {};
  for (const k of ['L', 'P']) {
    // promienie stawów dobrane do końców ogniw, żeby przejścia były ciągłe
    CZ.ramie[k] = ogniwo(0.068, 0.053, 0.25, mKevlar); mot.add(CZ.ramie[k]);
    CZ.lokiec[k] = kulaS(0.055, mOchr, 1.15, 1.0, 1.15); mot.add(CZ.lokiec[k]);
    CZ.przedr[k] = ogniwo(0.053, 0.043, 0.25, mKevlar); mot.add(CZ.przedr[k]);

    const d = new THREE.Group(); mot.add(d); CZ.dlon[k] = d;
    const rekaw = new THREE.Mesh(new THREE.CylinderGeometry(0.050, 0.058, 0.075, 12), mPas);
    rekaw.rotation.x = Math.PI / 2; rekaw.position.z = -0.045; d.add(rekaw);
    const dlon = kulaS(0.056, mRek, 1.05, 0.86, 1.55); dlon.position.z = 0.030; d.add(dlon);

    CZ.udo[k] = ogniwo(0.098, 0.072, 0.43, mKevlar); mot.add(CZ.udo[k]);
    CZ.kolano[k] = kulaS(0.074, mOchr, 1.05, 1.0, 1.12); mot.add(CZ.kolano[k]);
    CZ.lydka[k] = ogniwo(0.070, 0.052, 0.45, mKevlar); mot.add(CZ.lydka[k]);

    const bt = new THREE.Group(); mot.add(bt); CZ.but[k] = bt;
    const chol = new THREE.Mesh(new THREE.CylinderGeometry(0.056, 0.064, 0.185, 12), mBut);
    chol.position.y = 0.055; bt.add(chol);
    const stopa = kulaS(0.072, mBut, 0.98, 0.62, 1.80); stopa.position.set(0, -0.040, 0.072); bt.add(stopa);
    if (k === 'L') {
      const plyt = new THREE.Mesh(new THREE.BoxGeometry(0.104, 0.018, 0.285), mStal);
      plyt.position.set(0, -0.072, 0.082); bt.add(plyt);
      const pasS = new THREE.Mesh(new THREE.BoxGeometry(0.108, 0.026, 0.028), mPas);
      pasS.position.set(0, -0.026, 0.036); bt.add(pasS);
    }
  }

  root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
  root.userData = { przechyl, mot, przod, tyl, przodK, cz: CZ };
  return root;
}

/* ---------- ROOST: ziemia spod tylnego koła ---------- */
const Roost = (() => {
  const N = 1100;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
  const vel = new Float32Array(N * 3), zyc = new Float32Array(N);
  for (let i = 0; i < N; i++) { pos[i * 3 + 1] = -999; }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const c = plotno(32, 32), x = c.getContext('2d');
  const gr = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.45, 'rgba(255,255,255,.65)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 32, 32);
  const mat = new THREE.PointsMaterial({
    size: 0.17, map: new THREE.CanvasTexture(c), vertexColors: true,
    transparent: true, opacity: 0.92, depthWrite: false, sizeAttenuation: true,
    blending: THREE.NormalBlending
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  let kursor = 0;
  return {
    mesh: pts,
    emituj(b, ile) {
      const fx = Math.sin(b.psi), fz = Math.cos(b.psi);
      const lx = Math.cos(b.psi), lz = -Math.sin(b.psi);
      const bx = b.x - fx * 0.62, bz = b.z - fz * 0.62;
      const v = b.speed;
      for (let k = 0; k < ile; k++) {
        const i = kursor = (kursor + 1) % N;
        pos[i * 3] = bx + (Math.random() - .5) * 0.28;
        pos[i * 3 + 1] = 0.10 + Math.random() * 0.12;
        pos[i * 3 + 2] = bz + (Math.random() - .5) * 0.28;
        // ziemia leci do tyłu i na zewnątrz łuku
        const wyrzut = 3.2 + Math.random() * 5.5;
        const bok = (-0.9 - Math.random() * 2.4) * Math.sign(b.slipAng || -1);
        vel[i * 3] = -fx * wyrzut - lx * bok * 1.6 + (Math.random() - .5) * 1.6;
        vel[i * 3 + 1] = 2.4 + Math.random() * 4.4 + v * 0.05;
        vel[i * 3 + 2] = -fz * wyrzut - lz * bok * 1.6 + (Math.random() - .5) * 1.6;
        zyc[i] = 0.55 + Math.random() * 0.75;
        const j = 0.55 + Math.random() * 0.42;
        col[i * 3] = 0.34 * j; col[i * 3 + 1] = 0.23 * j; col[i * 3 + 2] = 0.16 * j;
      }
    },
    kurz(x0, y0, z0) {
      const i = kursor = (kursor + 1) % N;
      pos[i * 3] = x0 + (Math.random() - .5) * 2.2; pos[i * 3 + 1] = y0 + Math.random() * 1.2;
      pos[i * 3 + 2] = z0 + (Math.random() - .5) * 2.2;
      vel[i * 3] = (Math.random() - .5) * 0.7; vel[i * 3 + 1] = 0.3 + Math.random() * 0.5; vel[i * 3 + 2] = (Math.random() - .5) * 0.7;
      zyc[i] = 1.4 + Math.random(); col[i * 3] = 0.26; col[i * 3 + 1] = 0.20; col[i * 3 + 2] = 0.16;
    },
    krok(dt) {
      for (let i = 0; i < N; i++) {
        if (zyc[i] <= 0) continue;
        zyc[i] -= dt;
        if (zyc[i] <= 0) { pos[i * 3 + 1] = -999; continue; }
        vel[i * 3 + 1] -= 11.5 * dt;
        const op = Math.pow(0.28, dt);
        vel[i * 3] *= op; vel[i * 3 + 2] *= op;
        pos[i * 3] += vel[i * 3] * dt; pos[i * 3 + 1] += vel[i * 3 + 1] * dt; pos[i * 3 + 2] += vel[i * 3 + 2] * dt;
        if (pos[i * 3 + 1] < 0.03) { pos[i * 3 + 1] = 0.03; vel[i * 3 + 1] *= -0.16; }
        const f = Math.min(1, zyc[i] * 1.9);
        col[i * 3] *= 0.985; col[i * 3 + 1] *= 0.985; col[i * 3 + 2] *= 0.985;
        if (f < 1) { col[i * 3] *= 0.97; col[i * 3 + 1] *= 0.97; col[i * 3 + 2] *= 0.97; }
      }
      geo.attributes.position.needsUpdate = true;
      geo.attributes.color.needsUpdate = true;
    }
  };
})();

/* ---------- MONTAŻ ŚWIATA ---------- */
const swiat = new THREE.Group(); scena.add(swiat);
let meshTor = null, grpTasma = null, gotowyTor = false;
// Geometria toru zmienia się razem z gospodarzem meczu, więc siatki toru, stadionu
// i taśmy muszą zostać przebudowane. Bez tego fizyka jeździ po nowym torze, a obraz
// pokazuje stary — zawodnicy wjeżdżają na trybuny i stoją obok taśmy.
function zbudujSwiat() {
  if (gotowyTor && !G.torDoPrzebudowy) return;
  if (gotowyTor) {
    for (let i = swiat.children.length - 1; i >= 0; i--) {
      const o = swiat.children[i];
      if (o === Roost.mesh) continue;
      swiat.remove(o);
      if (o.traverse) o.traverse(x => { if (x.geometry && x.geometry.dispose) x.geometry.dispose(); });
    }
    KAM_TV.length = 0;                       // kamery TV liczone są z geometrii toru
  }
  G.torDoPrzebudowy = false;
  gotowyTor = true;
  meshTor = budujTor(); swiat.add(meshTor);
  budujStadion(swiat);
  grpTasma = budujTasme(swiat);
  if (swiat.children.indexOf(Roost.mesh) < 0) swiat.add(Roost.mesh);
}

/* ---------- KAMERY ---------- */
const kamStan = { poz: new THREE.Vector3(), cel: new THREE.Vector3(), kurs: 0, gotowa: false };
const KAM_TV = [];
function przygotujTV() {
  if (KAM_TV.length) return;
  for (let i = 0; i < 6; i++) {
    const s = i / 6 * TRK.L + 20;
    const p = fromTrack(s, TRK.HW + 11);
    KAM_TV.push(new THREE.Vector3(p.x, 7.5, p.z));
  }
}
function ustawKamere(b, dt) {
  przygotujTV();
  const fx = Math.sin(b.psi), fz = Math.cos(b.psi);
  const vx = b.u * fx + b.w * Math.cos(b.psi), vz = b.u * fz - b.w * Math.sin(b.psi);
  const kursSur = (b.speed > 2) ? Math.atan2(vx, vz) : b.psi;
  if (!kamStan.gotowa) { kamStan.kurs = kursSur; kamStan.gotowa = true; }
  kamStan.kurs += angWrap(kursSur - kamStan.kurs) * Math.min(1, dt * 4.2);
  const kx = Math.sin(kamStan.kurs), kz = Math.cos(kamStan.kurs);

  const odw = G.kamOdwrocona ? -1 : 1;      // Tab: kamera przeskakuje przed motocykl
  if (G.kamera === 0) {           // za motocyklem
    const d = 6.4 + b.speed * 0.075, h = 2.15 + b.speed * 0.012;
    kamStan.poz.set(b.x - kx * d * odw, h, b.z - kz * d * odw);
    kamStan.cel.set(b.x + kx * 7 * odw, 1.05, b.z + kz * 7 * odw);
    kam.position.lerp(kamStan.poz, Math.min(1, dt * 7.5));
  } else if (G.kamera === 1) {    // kask
    const px = Math.cos(b.psi), pz = -Math.sin(b.psi);
    const rl = b.roll * 0.5;
    kamStan.poz.set(b.x - fx * 0.05 + px * rl * 0.6, 1.42 - Math.abs(rl) * 0.16, b.z - fz * 0.05 + pz * rl * 0.6);
    kamStan.cel.set(b.x + (fx * 0.72 + kx * 0.28) * 14 * odw, 1.05, b.z + (fz * 0.72 + kz * 0.28) * 14 * odw);
    kam.position.copy(kamStan.poz);
    kam.up.set(Math.cos(b.psi) * -Math.sin(b.roll * 0.55), Math.cos(b.roll * 0.55), Math.sin(b.psi) * Math.sin(b.roll * 0.55));
  } else {                        // realizacja TV
    let best = KAM_TV[0], bd = 1e9;
    for (const c of KAM_TV) { const d = (c.x - b.x) ** 2 + (c.z - b.z) ** 2; if (d < bd) { bd = d; best = c; } }
    kam.position.lerp(best, Math.min(1, dt * 2.6));
    kamStan.cel.set(b.x, 0.9, b.z);
  }
  if (G.kamera !== 1) kam.up.set(0, 1, 0);
  kam.lookAt(kamStan.cel);
  const fov = fovZPoziomego(G.kamera === 1 ? 104 : 92 + clamp(b.speed - 18, 0, 14) * 0.75);
  kam.fov += (fov - kam.fov) * Math.min(1, dt * 3);
  kam.updateProjectionMatrix();
}

/* ======================= PRZYGOTOWANIE BIEGU ======================= */
const el = (id) => document.getElementById(id);
// Cztery pola rozstawione na całej użytecznej szerokości toru — przy sztywnym
// odstępie 3,4 m na wąskim torze pole D lądowało pod bandą.
function gate(i) {
  const uzyteczna = 2 * TRK.HW - 3.0;
  return -TRK.HW + 1.5 + i * (uzyteczna / 3);
}

function budujBieg() {
  zbudujSwiat();
  // usuń poprzednie modele
  G.bikes.forEach(b => { if (b.model) swiat.remove(b.model); });
  G.bikes = [];
  G.surf = new Surface((Math.random() * 1e6) | 0);
  G.surf.preWear(STANY_TORU[G.tryb === 'mecz' ? stanToruBiegu(G.mecz.bieg) : G.stanToru]);
  xSlady.clearRect(0, 0, TXW, TXH);
  malujTor();

  const poz = POZIOMY[G.poziom];
  // Obsada biegu: w trybie meczu przychodzi z tabeli biegowej (kask od drużyny,
  // pole startowe osobno), w pozostałych trybach kask odpowiada polu startowemu.
  const obsada = (G.tryb === 'mecz')
    ? obsadaBiegu(G.mecz, G.mecz.bieg).filter(o => o.numer !== G.wykluczonyNumer).map((o, i) => ({
        idx: i, pole: o.pole, kask: KASK_KOL[o.kask], numer: o.numer,
        gracz: o.numer === G.mecz.mojNumer, zaw2: o.zaw, gospodarz: o.gospodarz,
        kevlar: o.gospodarz ? G.mecz.barwy.gosp : G.mecz.barwy.gosc,
        pas: o.gospodarz ? G.mecz.barwy.gospA : G.mecz.barwy.goscA,
        par: parametryZaw(o.zaw)
      }))
    : ZAWODNICY.map((z, i) => ({
        idx: i, pole: i, kask: KASKI[i], numer: i + 1,
        gracz: i === G.wybor, zaw2: null, kevlar: z.kevlar, pas: z.pas,
        par: { skill: z.skill, style: z.styl, aggro: z.aggro, adapt: z.adapt,
               obrStartu: 9500, reakcja: 0.05 + Math.random() * 0.16, tolSlizgu: 1.20 }
      })).filter(o => !G.wykluczeni.includes(o.idx) && (G.tryb !== 'trening' || o.idx === G.wybor));

  obsada.forEach((o, kolejny) => {
    const i = o.idx, z = ZAWODNICY[i] || ZAWODNICY[0];
    const gracz = o.gracz;
    const b = new Bike({
      id: i, name: o.zaw2 ? o.zaw2.n : z.imie, style: o.par.style, skill: o.par.skill,
      aggro: o.par.aggro, adapt: o.par.adapt,
      assist: gracz ? poz.asysta : 1.0,
      tol: gracz ? poz.tol : (o.par.tolSlizgu || 1.0)
    });
    b.gracz = gracz; b.zaw = z; b.zaw2 = o.zaw2; b.kask = o.kask;
    b.numerMeczowy = o.numer; b.gospodarz = o.gospodarz; b.obs = o;
    b.reakcja = o.par.reakcja;
    const p = fromTrack(TRK.START_S - 0.7, gate(o.pole));
    b.x = p.x; b.z = p.z; b.psi = Math.atan2(p.hx, p.hz);
    b.u = 0; b.w = 0; b.r = 0; b.clutch = 0; b.we = rpm2rad(P.rpmIdle);
    b.obrStartu = o.par.obrStartu;
    b.lap = -1; b.prog = raceProgress(toTrack(b.x, b.z).s); b.lapTimes = []; b.lastLapT = 0;
    b.aiT = 0; b.aiInp = { throttle: 0, steer: 0, clutch: true };
    b.katKola = 0; b.katPrzod = 0; b.punkty = 0; b.finished = false;
    const m = budujMotocykl({ kask: o.kask, kevlar: o.kevlar, pas: o.pas, numer: o.numer,
      nazwa: o.zaw2 ? o.zaw2.n : z.imie });
    // Zawodnik z modelu zastępuje ten z brył: chowamy bryły i wstawiamy klon.
    if (G.model3d && G.zawodnikModel !== false) {
      const cz = m.userData.cz;
      // Klon musi wisieć na TEJ SAMEJ grupie co bryły zawodnika, czyli na
      // wewnętrznym „mot" — to ona dostaje przechył i podskok przy upadku.
      const zw = Zawodnik3D.stworz(m.userData.mot, {
        barwa1: o.kevlar, barwa2: o.pas, kask: o.kask,
        nazwisko: nazwaNaPlecy(o.zaw2 ? o.zaw2.n : z.imie), numer: o.numer
      });
      if (zw) {
        m.userData.mot.userData.zaw3d = zw;
        Object.keys(cz).forEach(k => {
          const c = cz[k];
          if (c && c.visible !== undefined) c.visible = false;
          else if (c) Object.keys(c).forEach(s2 => { if (c[s2] && c[s2].visible !== undefined) c[s2].visible = false; });
        });
      }
    }
    b.model = m; swiat.add(m);
    G.bikes.push(b);
  });
  G.gracz = G.bikes.find(b => b.gracz) || G.bikes[0];
  kamStan.gotowa = false; G.steerSm = 0; G.sterI = 0; G.deltaSm = 0;
  grpTasma.position.y = 0.72;
  G.tasma = 0;
  G.t = 0; G.tFazy = 0;
  G.najlepsza = null; G.tknieto = false; G.gazBezSprzegla = 0; G.podpowiedzSprzeglo = false;
  G.trasaNaj = null; G.trasaBiez = new Float32Array(120); G.delta = null;
  el('tabela').hidden = (G.tryb === 'trening');
  el('swiatla').style.display = G.tryb === 'trening' ? 'none' : '';   // w treningu sędzia nie startuje
  el('telemetria').hidden = !(G.tryb === 'trening' && G.telem);
  if (G.tryb === 'trening') {
    grpTasma.position.y = 4.2;                 // taśma podniesiona, sędzia nie czeka
    G.startT = 0; faza('trening');
    pokazKomunikat('TRENING', 'jedź kiedy chcesz — T telemetria, R powrót na linię', 2600);
  } else faza('prezentacja');
  // Po zakończeniu biegu kamera przechodzi na ujęcie telewizyjne pod ekran wyników.
  // Przy powtórce trzeba wrócić do widoku wybranego przez gracza, inaczej zostaje TV.
  G.kamera = G.kamGracza;
}

function faza(f) { G.faza = f; G.tFazy = 0; }

// powrót na linię startu z zachowaniem wyjeżdżonego toru — w treningu chcemy
// badać zachowanie na tej samej, stopniowo zmieniającej się nawierzchni
function resetTreningu() {
  const b = G.gracz; if (!b) return;
  const p = fromTrack(TRK.START_S - 0.7, gate(b.id));
  b.x = p.x; b.z = p.z; b.psi = Math.atan2(p.hx, p.hz);
  b.u = 0; b.w = 0; b.r = 0; b.roll = 0; b.spin = 0; b.down = 0;
  b.clutch = 0; b.we = rpm2rad(P.rpmIdle); b.thr = 0; b.steer = 0;
  b.lap = -1; b._zer = false; b.lapTimes = []; b.lastLapT = G.t;
  b.prog = raceProgress(toTrack(b.x, b.z).s); b.startOceniony = undefined;
  b._su = undefined; b.fxPrev = 0; b.aiI = 0;
  G.steerSm = 0; G.sterI = 0; G.deltaSm = 0; G.trasaBiez = new Float32Array(120); G.delta = null;
  kamStan.gotowa = false;
  pokazKomunikat('NA LINII', '', 1100);
}

function restartBiegu() {
  if (G.faza === 'menu') return;
  G.pauza = false; el('pauza').hidden = true;
  el('wyniki').hidden = true;
  budujBieg();
  Audio_.start();
}
function doMenu() {
  G.faza = 'menu'; G.pauza = false;
  el('pauza').hidden = true; el('wyniki').hidden = true;
  el('hud').hidden = true; el('menu').hidden = false; resize();
  G.wykluczeni = []; G.ostrzezenie = false;
  Audio_.stop();
}
function togglePauza() {
  G.pauza = !G.pauza; el('pauza').hidden = !G.pauza;
}

/* ======================= KOMUNIKATY ======================= */
let komTimer = null;
function pokazKomunikat(txt, pod, ms) {
  const k = el('komunikat');
  k.innerHTML = txt + (pod ? `<small>${pod}</small>` : '');
  k.classList.add('on');
  clearTimeout(komTimer);
  if (ms) komTimer = setTimeout(() => k.classList.remove('on'), ms);
}
function ukryjKomunikat() { el('komunikat').classList.remove('on'); }
function swiatla(stan) {
  const s = el('swiatla');
  s.classList.toggle('on', stan !== null);
  const lampy = s.querySelectorAll('i');
  lampy.forEach(x => { x.className = stan === 'zielone' ? 'zielone' : (stan === 'czerwone' ? 'czerwone' : ''); });
}

/* ======================= PRZERWANIE TAŚMY ======================= */
function dystansOdLinii(b) {
  return mod(b.s - TRK.START_S + TRK.L / 2, TRK.L) - TRK.L / 2;
}
function przerwijStart(b) {
  if (G.faza !== 'podTasma') return;
  faza('tasma');
  swiatla('czerwone');
  Audio_.pyk(180, 0.5, 'sawtooth');
  const kto = nazwaZaw(b) || 'zawodnik';
  // W MECZU LIGOWYM taśma nie daje ostrzeżenia — sędzia wyklucza od razu,
  // niezależnie od tego, czy zawinił gracz, czy zawodnik prowadzony przez bota.
  // Komunikat wskazuje konkretnego zawodnika, nie „Ciebie".
  if (G.tryb === 'mecz' && G.mecz) {
    pokazKomunikat('TAŚMA', `${kto} wykluczony z biegu — dotknął taśmy`, 0);
    setTimeout(() => { ukryjKomunikat(); swiatla(null); tasmaWMeczu(b); }, 2600);
    return;
  }
  if (b.gracz && !G.ostrzezenie) {
    G.ostrzezenie = true;
    pokazKomunikat('TAŚMA', 'Ostrzeżenie dla Ciebie — powtórka biegu', 0);
    setTimeout(() => { ukryjKomunikat(); swiatla(null); restartBiegu(); }, 2800);
  } else {
    G.wykluczeni.push(b.id);
    pokazKomunikat('TAŚMA', `${kto} wykluczony z biegu`, 0);
    setTimeout(() => {
      ukryjKomunikat(); swiatla(null);
      if (b.gracz) { koniecBiegu(true); } else restartBiegu();
    }, 2800);
  }
}

/* --- asysta prowadzenia: odpycha od band i pomaga łapać ślizg (tylko gracz) --- */
// Asysta pilnuje wyłącznie band. Kontrsterowanie wyszło z niej do modelu
// sterowania niżej — wcześniej oba mechanizmy walczyły ze sobą o kierownicę.
function asystaProwadzenia(b) {
  const lat = b.lat;
  let k = 0;
  if (lat > TRK.HW - 2.8) k += (lat - (TRK.HW - 2.8)) * 0.62;
  if (lat < -TRK.HW + 1.8) k -= (-TRK.HW + 1.8 - lat) * 0.62;
  return clamp(k, -1, 1);
}

/* ======================= KROK FIZYKI ======================= */
const DT = 1 / 200;
let akumulator = 0;

function krokFizyki(dt) {
  const poz = POZIOMY[G.poziom];
  const wIn = wejscieGracza();
  for (const b of G.bikes) {
    let inp;
    if (b.gracz) {
      if (G.faza === 'prezentacja' || G.faza === 'tasma') inp = { throttle: 0, steer: 0, clutch: true };
      else if (G.faza === 'podTasma') {
        // dopóki zawodnik nie sięgnie po sprzęgło, maszyna trzyma go pod taśmą;
        // gdy już je wyciśnie — puszczenie za wcześnie oznacza przerwaną taśmę
        if (wIn.clutch) G.tknieto = true;
        // Dopóki zawodnik nie sięgnie po sprzęgło, NIE DZIAŁA TEŻ GAZ. Wcześniej
        // gaz przechodził: dało się nakręcić silnik do oporu bez żadnego ryzyka
        // taśmy, a po jej podniesieniu maszyna i tak dobrze ruszała — sprzęgło
        // przestawało być do czegokolwiek potrzebne.
        if (G.tknieto) inp = { throttle: wIn.throttle, steer: 0, clutch: wIn.clutch };
        else {
          inp = { throttle: 0, steer: 0, clutch: true };
          // podpowiedź dla kogoś, kto trzyma sam gaz i nie rozumie, czemu nic się nie dzieje
          G.gazBezSprzegla = wIn.throttle > 0.2 ? (G.gazBezSprzegla || 0) + dt : 0;
          if (G.gazBezSprzegla > 0.8 && !G.podpowiedzSprzeglo) {
            G.podpowiedzSprzeglo = true;
            pokazKomunikat('SPRZĘGŁO', 'wyciśnij Spację i kręć silnik gazem', 2200);
          }
        }
      }
      else {
        // kierownica narasta stopniowo — im dłużej trzymasz klawisz, tym większy skręt i przechył.
        // Zmiana strony i powrót do środka są szybsze niż dokładanie skrętu.
        const cel = wIn.steer;
        const zmiana = cel !== 0 && G.steerSm !== 0 && Math.sign(cel) !== Math.sign(G.steerSm);
        const tempo = cel === 0 ? 6.0 : (zmiana ? 6.0 : 2.20);
        G.steerSm = clamp(G.steerSm + clamp(cel - G.steerSm, -tempo * dt, tempo * dt), -1, 1);
        const krzywa = Math.sign(G.steerSm) * Math.pow(Math.abs(G.steerSm), 1.35);

        // STEROWANIE PRZEZ ZADANĄ PRĘDKOŚĆ KĄTOWĄ.
        // Klawisz nie ustawia kierownicy i nie zamawia siły na przodzie — mówi,
        // jak ciasny łuk zawodnik chce jechać. Granicę wyznacza fizyka: przy
        // przyspieszeniu bocznym do ~1,6 g maksymalna prędkość kątowa to a/v,
        // więc przy 100 km/h wychodzi 0,56 rad/s, a przy 60 km/h aż 0,98.
        // Stąd bierze się naturalna różnica: wolniej motocykl wchodzi w łuk
        // ciaśniej, szybciej — szerzej, bez żadnych sztucznych ograniczników.
        // Klawisz zadaje KRZYWIZNĘ toru jazdy, nie prędkość kątową. Przy zadawaniu
        // prędkości kątowej ślizg się rozbiegał: hamowanie ślizgiem zbijało prędkość,
        // spadek prędkości podnosił żądanie (a/v), a to pogłębiało ślizg — motocykl
        // albo stawał bokiem, albo nie ślizgał wcale. Krzywizna razy prędkość daje
        // sprzężenie odwrotne: wolniej = łagodniej, więc ślizg sam się stabilizuje.
        // Najciaśniejszy zadawalny łuk to ~25 m, czyli przy 80 km/h około 2 g —
        // więcej, niż utrzyma opona, więc pełne wychylenie wymusza wyjście tyłu.
        // Górna granica żądania jest wyższa niż to, co utrzyma sama opona — przy pełnym
        // wychyleniu zawodnik prosi o ciaśniejszy łuk niż daje przyczepność i tył musi
        // wyjść na zewnątrz. Stąd płynny ślizg zamiast grzecznego pokonywania łuku.
        const rCel = krzywa * clamp(0.065 * b.speed, 0.10, 1.20) * poz.dMax;
        const err = rCel - b.r;
        G.sterI = clamp((G.sterI || 0) + err * dt * 0.70, -0.13, 0.13);
        if (Math.abs(err) < 0.03) G.sterI *= Math.pow(0.70, dt * 60);
        // model odwrotny opony przedniej — kontrsterowanie w ślizgu wychodzi samo
        const alfaCmd = -clamp(1.05 * err + G.sterI, -0.30, 0.30);
        const delta = b.slipAng + P.a * b.r / Math.max(b.u, 6) - alfaCmd;
        const pom = poz.prowadz * asystaProwadzenia(b) * P.dMax;
        // wygładzenie: bez niego kierownica drga między klatkami i ślizg wygląda nerwowo
        if (G.deltaSm === undefined) G.deltaSm = 0;
        G.deltaSm += (delta + pom - G.deltaSm) * Math.min(1, dt * 22);
        b.leanCmd = G.steerSm;
        inp = { throttle: wIn.throttle, clutch: wIn.clutch,
                steer: clamp(G.deltaSm, -P.dMax, P.dMax) / P.dMax };
      }
      // pod gazem zawodnik kładzie się na kierownicy — inaczej przód wystrzeliłby w górę
      b.rideWeight = b.finished ? 0.4 : (wIn.ciezar ? -0.85 : clamp(0.42 + 0.48 * b.thr - b.spin * 0.9, -1, 1));
      if ((G.faza === 'jazda' || G.faza === 'trening') && b.startOceniony === undefined && !inp.clutch) {
        b.startOceniony = b.rpm;
        const r = b.rpm;
        if (r > 8500 && r < 10500) { b.gripMul = 1.07; b.gripDo = G.t + 1.3; pokazKomunikat('DOBRY START', '', 1400); }
        else if (r <= 8500) pokazKomunikat('ZGAŚNIĘTY START', 'za mało obrotów', 1400);
        else pokazKomunikat('PRZEPALONE KOŁO', 'za dużo obrotów', 1400);
      }
      if (b.gripDo && G.t > b.gripDo) { b.gripMul = 1; b.gripDo = 0; }
    } else {
      b.aiT -= dt;
      if (b.aiT <= 0) {
        b.aiT = 0.02;
        if (G.faza === 'jazda' || G.faza === 'meta' || G.faza === 'trening') {
          b.aiInp = aiControl(b, G.bikes, G.surf, G.t, { pace: poz.pace, dt: 0.02 });
          if (G.t - G.startT < b.reakcja) b.aiInp.clutch = true;
          else if (G.t - G.startT < b.reakcja + 0.35) b.aiInp.throttle = 1;
        } else if (G.faza === 'podTasma') {
          b.aiInp = { throttle: 0.5 + 0.35 * Math.abs(Math.sin(G.t * 3.1 + b.id)), steer: 0, clutch: true };
        } else b.aiInp = { throttle: 0, steer: 0, clutch: true };
      }
      inp = b.aiInp;
    }
    inp.launchRate = 3.1;
    b.step(dt, inp, G.surf, G.t);
    sladMotocykla(b);

    if (G.faza === 'podTasma' && dystansOdLinii(b) > 0.06) przerwijStart(b);

    // Upadek kończy bieg dla tego zawodnika — nie wstaje, nie dojeżdża, nie punktuje.
    // Kto minął metę, ma wynik zaklepany — upadek na wybiegu już nic nie zabiera.
    if (b.down > 0 && !b.upadl && !b.finished && (G.faza === 'jazda' || G.faza === 'meta')) {
      b.upadl = true; b.down = 999;
      if (b.gracz) pokazKomunikat('UPADEK', 'bieg zakończony', 2200);
    }
    if (b.lap === 0 && !b._zer) { b._zer = true; b.lapTimes = []; b.lastLapT = G.t; }
    if (G.faza === 'trening' && b.gracz) probkujTrening(b);
    if (G.tryb !== 'trening' && !b.finished && b.lap >= G.okrazen) {
      b.finished = true; b.finishT = G.t - G.startT;
      if (b.gracz) { pokazKomunikat('META', '', 2200); Audio_.pyk(880, 0.25); }
    }
  }
  // KONTAKT MIĘDZY MOTOCYKLAMI.
  // Odbicie jest symetryczne: obaj dostają równy i przeciwny impuls, bo mają tę samą
  // masę. Wcześniej kara zależała od kolejności w tablicy i zawodnik z wewnętrznego
  // pola tracił zawsze — pole D wygrywało 24 biegi na 24. O skutku decyduje impet:
  // lekkie otarcie odbija, mocny wjazd przewraca i wyklucza sprawcę.
  for (let i = 0; i < G.bikes.length; i++) for (let j = i + 1; j < G.bikes.length; j++) {
    const A = G.bikes[i], B = G.bikes[j];
    if (A.down > 0 || B.down > 0) continue;
    const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz);
    if (d >= 1.30 || d <= 1e-4) continue;
    const nx = dx / d, nz = dz / d, ov = (1.30 - d) * 0.5;
    A.x -= nx * ov; A.z -= nz * ov; B.x += nx * ov; B.z += nz * ov;

    const wSwiat = b => [b.u * Math.sin(b.psi) + b.w * Math.cos(b.psi),
                         b.u * Math.cos(b.psi) - b.w * Math.sin(b.psi)];
    const rzut = b => { const v = wSwiat(b); return v[0] * nx + v[1] * nz; };
    const zbliz = rzut(A) - rzut(B);
    A.contact = 1; B.contact = 1;
    if (zbliz <= 0) continue;                       // rozjeżdżają się, nic się nie dzieje

    // impuls dzielony po połowie — żadna ze stron nie jest uprzywilejowana
    const spr = 0.35;                               // sprężystość kontaktu
    const j2 = zbliz * (1 + spr) * 0.5;
    const dodaj = (b, sx, sz2) => {
      b.u += sx * Math.sin(b.psi) + sz2 * Math.cos(b.psi);
      b.w += sx * Math.cos(b.psi) - sz2 * Math.sin(b.psi);
    };
    dodaj(A, -j2 * nx, -j2 * nz);
    dodaj(B, j2 * nx, j2 * nz);
    // tarcie o rywala zabiera trochę prędkości obu, mocniej dojeżdżającemu
    const strata = clamp(zbliz * 0.012, 0, 0.10);
    A.u *= 1 - strata; B.u *= 1 - strata * 0.6;
    A.r += (Math.random() - 0.5) * zbliz * 0.05;
    B.r += (Math.random() - 0.5) * zbliz * 0.05;

    // mocny wjazd: sprawcą jest ten, kto dojeżdżał
    // Próg dobrany pomiarowo: przy 11 m/s wykluczenie padało w 9 biegach na 24.
    // Przy 13 m/s i zróżnicowanych stylach jazdy — jak w danych klubowych — nie padło
    // ani razu w 24 biegach, ale zostaje osiągalne dla świadomego wjechania w rywala.
    if (zbliz > 13 && Math.min(A.speed, B.speed) > 9) {
      B.fall('kontakt');                      // upadek = koniec biegu dla poszkodowanego
      A.u *= 0.55;
    }
  }
}

// Brutalny wjazd w rywala albo w bandę: sprawca wykluczony, bieg powtórzony.
// Obaj muszą jechać — inaczej mijający dostawałby wykluczenie za "wjechanie"
// w zawodnika stojącego po upadku, choć to nie jego wina.
function przewinienie(b, powod) {
  if (G.przewinienie) return;
  G.przewinienie = { id: b.id, powod };
  faza('tasma'); swiatla('czerwone'); Audio_.pyk(170, 0.55, 'sawtooth');
  const kto = nazwaZaw(b) || 'zawodnik';
  pokazKomunikat('WYKLUCZONY', `${kto} — ${powod}. Powtórka biegu.`, 0);
  setTimeout(() => {
    ukryjKomunikat(); swiatla(null);
    const byl = G.przewinienie; G.przewinienie = null;
    if (G.tryb === 'mecz') {
      const bk = G.bikes.find(x => x.id === byl.id);
      G.wykluczonyNumer = bk ? bk.numerMeczowy : null;
      restartBiegu();
    } else {
      G.wykluczeni.push(byl.id);
      if (b.gracz) koniecBiegu(true); else restartBiegu();
    }
  }, 3000);
}

// zapis przebiegu okrążenia co 1/120 dystansu — stąd bierze się strata/zysk
// względem najlepszego przejazdu, pokazywana na żywo w telemetrii
function probkujTrening(b) {
  const bin = clamp(Math.floor(b.prog / TRK.L * 120), 0, 119);
  const tOkr = G.t - b.lastLapT;
  if (bin !== b._bin) {
    b._bin = bin;
    G.trasaBiez[bin] = tOkr;
    G.delta = G.trasaNaj && G.trasaNaj[bin] > 0 ? tOkr - G.trasaNaj[bin] : null;
  }
  if (b.lapTimes.length !== (b._ileOkr || 0)) {
    b._ileOkr = b.lapTimes.length;
    const ost = b.lapTimes[b.lapTimes.length - 1];
    if (ost > 5 && (G.najlepsza === null || ost < G.najlepsza)) {
      G.trasaNaj = G.trasaBiez.slice();
    }
    G.trasaBiez = new Float32Array(120);
  }
}

// Brutalny wjazd w rywala albo w bandę: sprawca wykluczony, bieg powtórzony.
// Obaj muszą jechać. Bez tego mijający rywal dostawał wykluczenie za "wjechanie"
// w zawodnika stojącego po upadku, choć to nie jego wina.
const kontaktWJezdzie = (A, B) => Math.min(A.speed, B.speed) > 9;
function przewinienie(b, powod) {
  if (G.przewinienie) return;
  G.przewinienie = { id: b.id, powod };
  faza('tasma'); swiatla('czerwone'); Audio_.pyk(170, 0.55, 'sawtooth');
  const kto = b.zaw ? b.zaw.n : (b.zaw2 ? b.zaw2.n : (ZAWODNICY[b.id] ? ZAWODNICY[b.id].imie : 'zawodnik'));
  pokazKomunikat('WYKLUCZONY', `${kto} — ${powod}. Powtórka biegu.`, 0);
  setTimeout(() => {
    ukryjKomunikat(); swiatla(null);
    const byl = G.przewinienie; G.przewinienie = null;
    if (G.tryb === 'mecz') { const bk = G.bikes.find(x => x.id === byl.id); G.wykluczonyNumer = bk ? bk.numerMeczowy : null; restartBiegu(); }
    else { G.wykluczeni.push(byl.id); if (b.gracz) koniecBiegu(true); else restartBiegu(); }
  }, 3000);
}

// Flagi klubowe nad trybunami. Jedna siatka instancjonowana na cały sektor,
// więc koszt rysowania jest stały niezależnie od ich liczby.
const Flagi = {
  mesh: null, dane: [], pom: null,
  buduj(root, kl) {
    this.mesh = null; this.dane = [];
    if (!kl) return;
    const ILE = 110;
    const g = new THREE.PlaneGeometry(0.62, 0.40);
    g.translate(0.31, 0, 0);                       // obrót wokół drzewca, nie środka płata
    const im = new THREE.InstancedMesh(g, M({ side: THREE.DoubleSide, roughness: .88 }), ILE);
    const kol = new THREE.Color();
    for (let i = 0; i < ILE; i++) {
      const st = TRK.L * Math.random();
      const k = 2 + Math.floor(Math.random() * 7);
      const q = fromTrack(st, TRK.HW + 4.6 + k * 1.55);
      this.dane.push({
        x: q.x, y: 1.2 + k * 0.92 + 1.30, z: q.z,
        obr: Math.atan2(-q.hx, -q.hz), faza: Math.random() * 6.28,
        tempo: 1.5 + Math.random() * 1.6
      });
      kol.set(i % 2 ? kl.b1 : kl.b2); im.setColorAt(i, kol);
    }
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.pom = new THREE.Object3D();
    this.mesh = im; root.add(im);
  },
  krok(t) {
    if (!this.mesh) return;
    const d = this.pom;
    for (let i = 0; i < this.dane.length; i++) {
      const f = this.dane[i], w = Math.sin(t * f.tempo + f.faza);
      d.position.set(f.x, f.y + w * 0.09, f.z);
      d.rotation.set(0.18 * w, f.obr + 0.40 * w, 0.26 * w);
      d.updateMatrix(); this.mesh.setMatrixAt(i, d.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
};

/* ======================= ANIMACJA MODELI ======================= */
function aktualizujModele(dt) {
  for (const b of G.bikes) {
    const m = b.model, u = m.userData;
    m.position.set(b.x, surfaceY(b.s, b.lat), b.z);
    m.rotation.y = b.psi;
    const przechyl = b.down > 0 ? clamp(b.roll, -0.5, 0.5) + Math.sign(b.roll || 1) * 1.05
      : b.roll * 0.86 - clamp(b.leanCmd || 0, -1, 1) * 0.07;   // przytrzymany skręt dokłada przechyłu
    u.przechyl.rotation.z += (przechyl - u.przechyl.rotation.z) * Math.min(1, dt * 12);
    u.mot.position.y = b.down > 0 ? -0.22 : 0;
    u.mot.rotation.x = -b.wheelie * 0.22;

    // koła
    const obr = b.speed / P.rW * (1 + b.spin) * dt;
    b.katKola -= obr;
    u.tyl.rotation.x = b.katKola;
    u.przodK.rotation.x = b.katKola * 0.98;
    u.przod.rotation.y = b.steer;

    ustawPostac(b, u.cz, dt, u.mot);
    m.visible = true;

    // ziemia spod koła
    if (b.down <= 0 && b.dirtRate > 0.05 && b.speed > 4) {
      const ile = Math.min(7, Math.round(b.dirtRate * 8 * (b.gracz ? 1.25 : 0.85)));
      if (ile > 0) Roost.emituj(b, ile);
    }
  }
  Roost.krok(dt);
  Flagi.krok(G.t);
}

/* --- pozycja zawodnika: liczona co klatkę ze stanu motocykla --- */
function ustawPostac(b, C, dt, mot) {
  const upadek = b.down > 0 ? 1 : 0;
  const slide = clamp(Math.abs(b.slipAng) / 0.42, 0, 1) * (1 - upadek);
  const lean = clamp(-b.roll, 0, 0.90) * (1 - upadek);
  const w = clamp(b.rideWeight || 0, -1, 1);
  const gaz = clamp(b.thr, 0, 1);

  // biodra: pod gazem do przodu, w przechyle niżej i do wnętrza łuku
  // punkty mocowania z nowego modelu: siodło 0.843, manetki (±0.343, 1.078, 0.518),
  // podnóżek (±0.1225, 0.301, -0.154), oś skrętu (0, 0.791, 0.5425)
  const hx = 0.090 * lean;
  const hy = 0.870 - 0.160 * lean - 0.10 * upadek;
  const hz = -0.170 + 0.045 * w;

  // tułów: oś biodra -> kark
  const TUL = 0.50;
  const pochyl = 0.55 + 0.08 * gaz - 0.18 * clamp(-w, 0, 1) + 0.30 * upadek;
  const bok = 0.07 + 0.20 * lean;
  let ux = Math.sin(bok), uy = Math.cos(pochyl), uz = Math.sin(pochyl);
  const nl = Math.hypot(ux, uy, uz); ux /= nl; uy /= nl; uz /= nl;
  C.tulow.position.set(hx, hy, hz);
  _kier.set(ux, uy, uz);
  C.tulow.quaternion.setFromUnitVectors(OS_Y, _kier);

  // głowa: trzymana poziomo, patrzy w łuk
  const gd = TUL + 0.112;   // kask osadzony między barkami, nie na wyciągniętej szyi
  C.glowa.position.set(hx + ux * gd, hy + uy * gd + 0.02, hz + uz * gd);
  const patrz = clamp(b.r * 0.50 + slide * 0.30, -0.65, 0.65);
  C.glowa.rotation.set(0.24 - 0.20 * gaz, patrz, -0.16 * lean);

  // ręce sięgają do manetek — te obracają się razem z kierownicą
  const cs = Math.cos(b.steer), sn = Math.sin(b.steer);
  const sy = hy + uy * 0.455, sz = hz + uz * 0.455;
  const chwyty = [
    { k: 'L', sx: hx + 0.136, gx: 0.343 * cs - 0.0245 * sn, gz: 0.5425 - 0.343 * sn - 0.0245 * cs, p: 1 },
    { k: 'P', sx: hx - 0.136, gx: -0.343 * cs - 0.0245 * sn, gz: 0.5425 + 0.343 * sn - 0.0245 * cs, p: -1 }
  ];
  for (const c of chwyty) {
    // biegun zgięcia skierowany do tyłu — łokcie przy tułowiu, nie rozstawione na boki
    staw(c.sx, sy, sz, c.gx, 1.078, c.gz, 0.25, 0.25, c.p * 0.02, 0.30, -0.95);
    const ex = _staw.x, ey = _staw.y, ez = _staw.z;
    const dx = _cel.x, dy = _cel.y, dz = _cel.z;
    ustawOgniwo(C.ramie[c.k], c.sx, sy, sz, ex, ey, ez);
    ustawOgniwo(C.przedr[c.k], ex, ey, ez, dx, dy, dz);
    C.lokiec[c.k].position.set(ex, ey, ez);
    C.dlon[c.k].position.set(dx, dy, dz);
    C.dlon[c.k].rotation.set(0, b.steer, 0);
  }

  // prawa noga trzyma podnóżek, lewa wychodzi do ślizgu i sunie stalowym butem po torze
  const xE = 0.24 + 0.12 * slide, zE = 0.18 + 0.16 * slide;
  const yE = clamp(xE * Math.tan(lean) + 0.03, 0.03, 0.55);
  const nogi = [
    { k: 'P', hx: hx - 0.108, fx: -0.1225, fy: 0.301, fz: -0.154, px: -0.20, pz: 1.0, tx: -0.06, ty: -0.12 },
    { k: 'L', hx: hx + 0.108, fx: lerp(0.1225, xE, slide), fy: lerp(0.301, yE, slide), fz: lerp(-0.154, zE, slide),
      px: 0.20 + 0.26 * slide, pz: 1.0, tx: 0.10 + 0.24 * slide, ty: -0.30 + 0.16 * slide }
  ];
  for (const n of nogi) {
    // kolana prowadzone do przodu, przy motocyklu — nie rozjeżdżają się na boki
    staw(n.hx, hy - 0.02, hz - 0.03, n.fx, n.fy, n.fz, 0.43, 0.45, n.px, -0.12, n.pz);
    const kx = _staw.x, ky = _staw.y, kz = _staw.z;
    const ax = _cel.x, ay = _cel.y, az = _cel.z;
    ustawOgniwo(C.udo[n.k], n.hx, hy - 0.02, hz - 0.03, kx, ky, kz);
    ustawOgniwo(C.lydka[n.k], kx, ky, kz, ax, ay, az);
    C.kolano[n.k].position.set(kx, ky, kz);
    ustawOs(C.but[n.k], ax, ay, az, n.tx, n.ty, 1, kx - ax, ky - ay, kz - az);
  }

  // Zawodnik z modelu układany jest na TYCH SAMYCH punktach co ten z brył:
  // biodra, kierunek tułowia, manetki i podnóżki. Dzięki temu reakcja na
  // ślizg, przechył, gaz i upadek jest identyczna — zmienia się tylko bryła.
  const z3 = mot && mot.userData ? mot.userData.zaw3d : null;
  if (z3) {
    const L = chwyty[0], P = chwyty[1];
    const nP = nogi[0], nL = nogi[1];
    Zawodnik3D.pozuj(z3, mot, {
      bx: hx, by: hy, bz: hz,
      ux, uy, uz,
      glx: L.gx, gly: 1.078, glz: L.gz,
      gpx: P.gx, gpy: 1.078, gpz: P.gz,
      slx: nL.fx, sly: nL.fy, slz: nL.fz,
      spx: nP.fx, spy: nP.fy, spz: nP.fz,
      patrz, steer: b.steer
    });
  }
}

/* ======================= OBROTOMIERZ (SVG) ======================= */
(function budujObrotomierz() {
  const svg = el('obrotomierz'), NS_ = 'http://www.w3.org/2000/svg';
  const ang = t => (150 + t * 240) * Math.PI / 180;
  const pt = (t, r) => [100 + r * Math.cos(ang(t)), 100 + r * Math.sin(ang(t))];
  const luk = (t0, t1, r) => {
    const [x0, y0] = pt(t0, r), [x1, y1] = pt(t1, r);
    return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${(t1 - t0) * 240 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  };
  const add = (n, a) => { const e = document.createElementNS(NS_, n); for (const k in a) e.setAttribute(k, a[k]); svg.appendChild(e); return e; };
  add('circle', { cx: 100, cy: 100, r: 92, fill: 'rgba(9,14,19,.66)', stroke: 'rgba(120,145,165,.22)', 'stroke-width': 1.5 });
  add('path', { d: luk(0, 1, 78), fill: 'none', stroke: 'rgba(140,165,185,.28)', 'stroke-width': 7 });
  add('path', { d: luk(8500 / 12000, 10500 / 12000, 78), fill: 'none', stroke: '#22d24e', 'stroke-width': 7, opacity: .85 });
  add('path', { d: luk(11000 / 12000, 1, 78), fill: 'none', stroke: '#e8332a', 'stroke-width': 7, opacity: .9 });
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, [x0, y0] = pt(t, 68), [x1, y1] = pt(t, i % 2 ? 60 : 55);
    add('line', { x1: x0, y1: y0, x2: x1, y2: y1, stroke: 'rgba(200,215,228,.55)', 'stroke-width': i % 2 ? 1.4 : 2.6 });
    if (i % 2 === 0) {
      const [tx, ty] = pt(t, 44);
      const e = add('text', { x: tx, y: ty + 4, fill: 'rgba(180,198,212,.7)', 'font-size': 13, 'text-anchor': 'middle', 'font-family': 'Barlow Condensed, sans-serif' });
      e.textContent = i;
    }
  }
  window._wsk = add('line', { x1: 100, y1: 100, x2: 100, y2: 30, stroke: '#ffe7bc', 'stroke-width': 3.2, 'stroke-linecap': 'round' });
  add('circle', { cx: 100, cy: 100, r: 7, fill: '#1a232c', stroke: 'rgba(200,215,228,.5)', 'stroke-width': 1.5 });
  window._wskAng = (t) => {
    const [x, y] = pt(clamp(t, 0, 1), 72);
    window._wsk.setAttribute('x2', x.toFixed(1)); window._wsk.setAttribute('y2', y.toFixed(1));
  };
})();

// W meczu motocykl niesie zawodnika z klubu (zaw2), w biegu indywidualnym stałą
// obsadę (zaw). Tablica wyników brała zawsze tę drugą i pokazywała te same nazwiska.
const nazwaZaw = b => b.zaw2 ? b.zaw2.n : (b.zaw ? b.zaw.imie : '');
const kolorZaw = b => b.kask || '#888';

/* ======================= HUD ======================= */
function czasTxt(s) {
  if (s == null || !isFinite(s)) return '—';
  const m = Math.floor(s / 60), r = s - m * 60;
  return m > 0 ? `${m}:${r.toFixed(2).padStart(5, '0')}` : r.toFixed(2);
}
function kolejnosc() {
  return G.bikes.slice().sort((a, b) => {
    if (a.finished && b.finished) return a.finishT - b.finishT;
    if (a.finished) return -1; if (b.finished) return 1;
    if (!!a.upadl !== !!b.upadl) return a.upadl ? 1 : -1;   // po upadku zawsze na końcu
    return b.total - a.total;
  });
}
let hudT = 0;
function aktualizujHUD(dt) {
  const b = G.gracz; if (!b) return;
  window._wskAng(b.rpm / 12000);
  el('kmh').textContent = Math.round(b.speed * 3.6);
  const sl = clamp(-b.slipAng / 0.9, -1, 1);
  const w = el('slizgWsk');
  w.style.left = (50 + sl * 50) + '%';
  const a = Math.abs(b.slipAng);
  w.style.background = a > 0.72 ? '#e8332a' : (a > 0.42 ? '#f2c500' : '#7ee08e');

  hudT -= dt; if (hudT > 0) return; hudT = 0.1;
  // po upadku gracz nie musi czekać, aż AI dojedzie do końca
  const czekaPoUpadku = G.gracz && G.gracz.upadl && (G.faza === 'jazda' || G.faza === 'meta');
  el('dokonczBtn').hidden = !czekaPoUpadku;
  // tablica wyniku meczu — jak na stadionie, widoczna przez cały bieg
  if (G.tryb === 'mecz' && G.mecz) {
    el('tablicaMecz').hidden = false;
    el('tmGosp').textContent = G.mecz.punkty.gosp;
    el('tmGosc').textContent = G.mecz.punkty.gosc;
    el('tmBieg').textContent = 'BIEG ' + G.mecz.bieg;
  } else el('tablicaMecz').hidden = true;
  const kol = kolejnosc();
  const miejsce = kol.indexOf(b) + 1;
  el('miejsce').textContent = miejsce;
  el('pozycja').querySelector('em').textContent = '/' + G.bikes.length;
  el('okrNr').textContent = G.tryb === 'trening' ? Math.max(b.lap + 1, 1) : clamp(b.lap + 1, 1, G.okrazen);
  el('okr').querySelector('em').textContent = G.tryb === 'trening' ? '' : '/' + G.okrazen;
  el('pozycja').style.display = G.tryb === 'trening' ? 'none' : '';
  if (G.tryb === 'trening') { if (G.telem) rysujTelemetrie(b); rysujCzasyTreningu(b); return; }

  el('tabela').innerHTML = kol.map((x, i) => {
    const luka = (i === 0 || x.finished) ? (x.finished ? czasTxt(x.finishT) : '—')
      : '+' + ((kol[0].total - x.total) / Math.max(x.speed, 8)).toFixed(1) + ' s';
    return `<div class="w${x.gracz ? ' ja' : ''}"><s>${i + 1}</s><i style="background:${kolorZaw(x)}"></i>
      <u>${nazwaZaw(x)}</u><em>${x.down > 0 ? 'upadek' : luka}</em></div>`;
  }).join('');

  const teraz = (G.faza === 'jazda' || G.faza === 'trening') ? G.t - b.lastLapT : 0;
  const ost = b.lapTimes.length ? b.lapTimes[b.lapTimes.length - 1] : null;
  const naj = b.lapTimes.length ? Math.min(...b.lapTimes) : null;
  if (naj !== null && (G.najlepsza === null || naj < G.najlepsza)) G.najlepsza = naj;
  el('czasy').innerHTML =
    `bieżąca <b>${czasTxt(Math.max(0, teraz))}</b><br>` +
    `ostatnia <b>${czasTxt(ost)}</b><br>` +
    `najlepsza <b class="naj">${czasTxt(naj)}</b>`;
}

/* ---------- TELEMETRIA: liczby, na których stroi się mechanikę ---------- */
function rysujTelemetrie(b) {
  const W = P.m * 9.81, wb = P.a + P.b;
  const Tsh = clamp((b.fxPrev || 0) * P.h / wb, -W * 0.30, W * 0.30);
  const ws = clamp(b.rideWeight || 0, -1, 1) * 0.15;
  const Fzf = clamp(W * (P.b + ws) / wb - Tsh, 0, W * 1.02);
  const Fzr = clamp(W * (P.a - ws) / wb + Tsh, W * 0.18, W * 1.02);
  const vv = Math.max(b.speed, 5);
  const alfaF = (b.slipAng + P.a * b.r / Math.max(b.u, 6) - b.steer) * 57.3;
  const beta = b.slipAng * 57.3, prog = 0.98 * (b.tol || 1) * 57.3;
  const grip = G.surf ? G.surf.grip(b.s, b.lat) : 1;
  const w = (n, v, kl) => `<div class="w${kl ? ' ' + kl : ''}"><span>${n}</span><b>${v}</b></div>`;
  el('telemetria').innerHTML =
    `<h4>TELEMETRIA</h4>` +
    w('prędkość', (b.speed * 3.6).toFixed(0) + ' km/h') +
    w('obroty', Math.round(b.rpm)) +
    w('gaz', Math.round(b.thr * 100) + '%') +
    `<hr>` +
    w('kąt ślizgu', beta.toFixed(0) + '°', Math.abs(beta) > prog * 0.75 ? 'zle' : (Math.abs(beta) > prog * 0.5 ? 'ost' : '')) +
    w('próg upadku', prog.toFixed(0) + '°') +
    w('prędkość kątowa', b.r.toFixed(2) + ' rad/s') +
    w('przysp. boczne', Math.abs(b.gLat).toFixed(2) + ' g') +
    `<hr>` +
    w('kierownica', (b.steer * 57.3).toFixed(1) + '°') +
    w('znoszenie przodu', alfaF.toFixed(0) + '°', Math.abs(alfaF) > 19 ? 'ost' : '') +
    w('buksowanie', Math.round(b.spin * 100) + '%', b.spin > 0.3 ? 'ost' : '') +
    `<hr>` +
    w('docisk przód', Math.round(Fzf) + ' N', Fzf < 200 ? 'ost' : '') +
    w('docisk tył', Math.round(Fzr) + ' N') +
    w('przyczepność', grip.toFixed(2), grip < 0.75 ? 'ost' : '') +
    w('pozycja', (b.lat >= 0 ? '+' : '') + b.lat.toFixed(1) + ' m');
}
function rysujCzasyTreningu(b) {
  const teraz = G.t - b.lastLapT;
  const ost = b.lapTimes.length ? b.lapTimes[b.lapTimes.length - 1] : null;
  const naj = b.lapTimes.length ? Math.min(...b.lapTimes) : null;
  if (naj !== null && (G.najlepsza === null || naj < G.najlepsza)) G.najlepsza = naj;
  const d = G.delta;
  const dTxt = d === null ? '' :
    `<br>strata <b class="${d > 0 ? '' : 'naj'}">${d > 0 ? '+' : ''}${d.toFixed(2)}</b>`;
  el('czasy').innerHTML =
    `bieżąca <b>${czasTxt(Math.max(0, teraz))}</b><br>` +
    `ostatnia <b>${czasTxt(ost)}</b><br>` +
    `najlepsza <b class="naj">${czasTxt(naj)}</b>` + dTxt;
}

/* ======================= PRZEBIEG BIEGU ======================= */
function aktualizujFaze(dt) {
  G.tFazy += dt;
  switch (G.faza) {
    case 'prezentacja':
      if (G.tFazy > 2.6) {
        faza('podTasma');
        G.tasmaCzas = 1.5 + Math.random() * 2.0;
        swiatla('zielone');
        pokazKomunikat('POD TAŚMĘ', 'trzymaj Spację — sprzęgło — i kręć silnik', 0);
        Audio_.pyk(660, 0.18);
      }
      break;
    case 'podTasma':
      if (G.tFazy > G.tasmaCzas) {
        faza('jazda'); G.startT = G.t; G.tasma = 1;
        swiatla(null); ukryjKomunikat();
        Audio_.pyk(1180, 0.12, 'sine');
      }
      break;
    case 'trening':
      break;
    case 'jazda': {
      if (G.tasma > 0 && G.tasma < 1.6) {
        G.tasma += dt * 4.2;
        grpTasma.position.y = 0.72 + smooth(clamp(G.tasma - 1, 0, 1)) * 2.9;
      }
      const meta = G.bikes.filter(x => x.finished);
      if (meta.length > 0) { faza('meta'); }
      break;
    }
    case 'meta':
      if (G.bikes.every(x => x.finished || x.upadl) || G.tFazy > 9) {
        koniecBiegu(false);
      }
      break;
  }
}

function koniecBiegu(wykluczony) {
  if (G.faza === 'wynik') return;
  faza('wynik');
  Audio_.stop();                     // silniki milkną po przekroczeniu mety
  if (G.tryb === 'mecz') { koniecBieguMeczu(); return; }
  const PKT = [3, 2, 1, 0];
  const kol = kolejnosc();
  kol.forEach((b, i) => { b.punkty = b.finished ? (PKT[i] !== undefined ? PKT[i] : 0) : 0; });
  const ja = G.gracz;
  const miejsce = kol.indexOf(ja) + 1;
  el('wynikTytul').textContent = wykluczony ? 'Wykluczony z biegu' :
    (miejsce === 1 ? 'Wygrany bieg' : `Meta na ${miejsce}. pozycji`);
  el('wynikTabela').innerHTML = kol.map((b, i) => `
    <tr class="${b.gracz ? 'ja' : ''}">
      <td class="m">${b.finished ? i + 1 : '—'}</td>
      <td class="c"><i style="background:${kolorZaw(b)}"></i></td>
      <td>${nazwaZaw(b)}${b.gracz ? ' <span style="color:#ffe7bc">(Ty)</span>' : ''}</td>
      <td class="t">${b.finished ? czasTxt(b.finishT) : (b.upadl ? 'upadek' : 'nie ukończył')}</td>
      <td class="p">${b.upadl ? '<span class="upadekU">U</span>' : b.punkty}</td>
    </tr>`).join('') +
    (G.wykluczeni.length ? G.wykluczeni.map(id => `<tr><td class="m">w/u</td><td class="c"><i style="background:${KASKI[id]}"></i></td>
      <td>${ZAWODNICY[id].imie}</td><td class="t">taśma</td><td class="p">0</td></tr>`).join('') : '');

  const naj = ja.lapTimes.length ? Math.min(...ja.lapTimes) : null;
  el('wynikOpis').innerHTML = wykluczony
    ? 'Sędzia wykluczył Cię za dotknięcie taśmy. W żużlu taśma jest święta — czekaj na jej ruch, nie na własny odruch.'
    : `Twoja najlepsza kolejka: <b style="color:#7ee08e">${czasTxt(naj)}</b>. ` +
      `Punkty w biegu: <b style="color:#ffe7bc">${ja.punkty}</b> (3–2–1–0).` +
      (ja.falls ? ` Upadki: ${ja.falls}.` : '');
  el('wyniki').hidden = false;
  G.kamera = 2;                      // ujęcie telewizyjne pod ekran wyników
}

// Po przejechanym biegu w meczu: zapis wyniku i powrót do tabeli biegowej.
function koniecBieguMeczu() {
  Audio_.stop();                     // po mecie cisza aż do kolejnego biegu
  const m = G.mecz, nr = m.bieg;
  const pelna = obsadaBiegu(m, nr);
  pelna.forEach(o => { const bk = G.bikes.find(x => x.numerMeczowy === o.numer); o.upadek = !!(bk && bk.upadl); });
  const kol = kolejnosc().map(b => b.obs).filter(Boolean);
  const brak = pelna.filter(o => !kol.some(k => k.numer === o.numer));
  const finalna = [...kol.map(o => pelna.find(p => p.numer === o.numer)), ...brak];
  zapiszWynik(m, nr, finalna);
  el('hud').hidden = true;
  pokazWynikBiegu(nr, finalna, true);
}

// Domykamy bieg bez rysowania — po upadku gracza reszta stawki dojeżdża natychmiast.
function dokonczBieg() {
  if (G.faza !== 'jazda' && G.faza !== 'meta') return;
  el('dokonczBtn').hidden = true;
  const KROK = 1 / 120;
  let n = 0;
  while ((G.faza === 'jazda' || G.faza === 'meta') && n < 120 * 180) {
    G.t += KROK; krokFizyki(KROK); aktualizujFaze(KROK); n++;
  }
}

/* ======================= KAMERA W MENU ======================= */
let menuT = 0;
function kameraMenu(dt) {
  Flagi.krok(G.t);   // flagi powiewają także na ekranach meczu
  menuT += dt * 0.055;
  const s = mod(menuT * TRK.L, TRK.L);
  const p = fromTrack(s, TRK.HW + 6);
  kam.position.set(p.x, 6.4 + Math.sin(menuT * 3) * 1.2, p.z);
  const c = fromTrack(s + 62, -1);
  kam.up.set(0, 1, 0);
  kam.lookAt(c.x, 1.1, c.z);
  kam.fov = fovZPoziomego(86); kam.updateProjectionMatrix();
  if (Math.random() < 0.35) Roost.kurz(p.x * 0.4, 1.4, p.z * 0.4);
  Roost.krok(dt);
}


/* ======================= TRYB MECZU: DANE I LOGIKA ======================= */
const LIGI = { ekstraliga: 'Ekstraliga', '1liga': '1. Liga', '2liga': '2. Liga' };
const KASK_KOL = { C: '#d81f1f', N: '#1f5fd6', B: '#f0f0ee', Z: '#f2c500' };
const KASK_NAZ = { C: 'czerwony', N: 'niebieski', B: 'biały', Z: 'żółty' };
const POLE_IDX = { A: 0, B: 1, C: 2, D: 3 };

const klubPo = id => KLUBY.find(k => k.id === id);

// siła 1-100 -> tempo AI. Kompresja 13% wyznaczona pomiarowo: przy niej najlepszy
// zawodnik zdobywa 9-12 pkt z czterech startów, a mecze kończą się 39:39 do 50:28.
const skillZ = s => 1.00 - ((100 - s) / 100) * 0.13;

function parametryZaw(z) {
  return {
    skill: skillZ(z.s),
    style: clamp(z.sj / 100, 0.03, 0.97),
    aggro: z.ag / 100,
    adapt: z.ct / 100,
    obrStartu: 8600 + z.st * 22,          // obroty przy puszczeniu sprzęgła
    reakcja: 0.05 + (1 - z.st / 100) * 0.20,
    // Tolerancja ślizgu. Odkąd upadek kończy bieg, dawne pasmo 0,92-1,12 dawało
    // upadek w 14% przejazdów — w meczu przepadała jedna trzecia punktów.
    // Zmierzone w biegu z kolizjami: 1,20 daje 4%, 1,30 daje 2%. Pasmo 1,16-1,32
    // trzyma całą stawkę w tym przedziale, a słabszy w ślizgu wywraca się częściej.
    tolSlizgu: 1.16 + z.sl / 100 * 0.16
  };
}

// odległość barw w przestrzeni RGB — poniżej 60 drużyn nie da się odróżnić na torze
function odlBarw(a, b) {
  const r = h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16));
  const x = r(a), y = r(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
function barwyMeczu(gosp, gosc) {
  const bg = gosp.b1;
  let bs = gosc.b1;
  if (odlBarw(bg, bs) < 60) bs = gosc.b2;              // gość przechodzi na barwę dodatkową
  if (odlBarw(bg, bs) < 60) bs = '#2b3440';
  return { gosp: bg, gospA: gosp.b2, gosc: bs, goscA: gosc.b1 === bs ? gosc.b2 : gosc.b1 };
}

/* ---------- geometria toru gospodarza ---------- */
function ustawTor(dlugosc, szerokosc) {
  if (G.torAktualny && G.torAktualny.dl === dlugosc && G.torAktualny.sz === szerokosc) return;
  G.torAktualny = { dl: dlugosc, sz: szerokosc };
  G.torDoPrzebudowy = true;                  // siatki trzeba postawić od nowa
  const HW = clamp(szerokosc / 2, 6.0, 8.5);
  const p = 0.55;                                       // udział prostych
  TRK.S = p * dlugosc / 4;
  TRK.HW = HW;
  TRK.R = HW + (1 - p) * dlugosc / (2 * Math.PI);
  TRK.L = 4 * TRK.S + TAU * TRK.R;
  TRK.LEN_INNER = 4 * TRK.S + TAU * (TRK.R - TRK.HW);
  TRK.SEG1 = 2 * TRK.S;
  TRK.SEG2 = TRK.SEG1 + Math.PI * TRK.R;
  TRK.SEG3 = TRK.SEG2 + 2 * TRK.S;
  TRK.START_S = TRK.SEG1 - Math.min(58, TRK.S * 1.1);
  if (gotowyTor) zbudujSwiat();      // od razu stawiamy siatki pod nową geometrię
}
const TOR_BAZOWY = { dl: 349, sz: 14 };
// Nawierzchnia w meczu: świeżo równana na starcie, po dwóch biegach ubita,
// od piątego wyjeżdżona, a po ósmym równiarka wychodzi na tor i cykl rusza od nowa.
function stanToruBiegu(nr) {
  const f = (nr - 1) % 8;
  return f < 2 ? 0 : (f < 4 ? 1 : 2);
}
const OPIS_TORU = ['świeżo równany', 'po kilku biegach', 'wyjeżdżony'];
// przy pierwszym uruchomieniu geometria musi zostać zapisana jako aktualna
G.torAktualny = { dl: TOR_BAZOWY.dl, sz: TOR_BAZOWY.sz };

/* ---------- stan meczu ---------- */
function nowyMecz(gospId, goscId, jestemGospodarzem) {
  const gosp = klubPo(gospId), gosc = klubPo(goscId);
  const program = PROGRAM13.map(b => ({ ...b, pola: { ...b.pola }, wynik: null }));
  program.push({ nr: 14, nominowany: true, wynik: null });
  program.push({ nr: 15, nominowany: true, wynik: null });
  return {
    gosp, gosc,
    jestemGospodarzem,                                  // po której stronie jedzie gracz
    mojNumer: null,                                     // wybierany osobno w każdym biegu
    barwy: barwyMeczu(gosp, gosc),
    program, bieg: 1,
    punkty: { gosp: 0, gosc: 0 },
    indyw: {}, bonusy: {}, biegiZaw: {},
    tasma: {},                // numer biegu -> zawodnik wykluczony za taśmę
    rezerwa: { gosp: false, gosc: false },
    zamiany: {},              // numer biegu -> { numer w programie: numer zastępcy }
    rezerwaLicznik: { gosp: 0, gosc: 0 },                // najwyżej 3 zmiany na drużynę
    uzyciZastepcy: { gosp: [], gosc: [] },               // każdy może wejść tylko raz
    skonczony: false
  };
}

function zawodnikNr(m, numer, nrBiegu) {
  const zam = nrBiegu && m.zamiany[nrBiegu] ? m.zamiany[nrBiegu][numer] : null;
  const n = zam || numer;
  const klub = n >= 9 ? m.gosp : m.gosc;
  const poz = n >= 9 ? n - 8 : n;
  return klub.z.find(z => z.p === poz);
}

// obsada biegu: cztery wpisy z kaskiem i polem startowym
function obsadaBiegu(m, nr) {
  const b = m.program[nr - 1];
  if (!b || !b.gosp) return null;
  const kaski = { [b.gosp[0]]: 'C', [b.gosp[1]]: 'N', [b.gosc[0]]: 'B', [b.gosc[1]]: 'Z' };
  return [...b.gosp, ...b.gosc].map(numer => ({
    numer, zaw: zawodnikNr(m, numer, nr), zastapiony: !!(m.zamiany[nr] && m.zamiany[nr][numer]),
    gospodarz: numer >= 9,
    kask: kaski[numer],
    pole: POLE_IDX[b.pola[numer]]
  }));
}
// W meczu jeździsz w każdym biegu — wybierasz tylko, którym z dwóch swoich zawodników.
const mojeNumeryWBiegu = (m, nr) => {
  const b = m.program[nr - 1];
  if (!b || !b.gosp) return [];
  return m.jestemGospodarzem ? [...b.gosp] : [...b.gosc];
};

/* ---------- księgowanie ---------- */
function zapiszWynik(m, nr, kolejnosc) {
  const PKT = [3, 2, 1, 0];
  const b = m.program[nr - 1];
  // Zawodnik po upadku nie punktuje: dostaje literę U i zero, a pozostali
  // dzielą miejsca od góry, jakby go w biegu nie było.
  let miejsce = 0;
  b.wynik = kolejnosc.map(o => o.upadek
    ? { numer: o.numer, pkt: 0, upadek: true, zaw: o.zaw }
    : { numer: o.numer, pkt: PKT[miejsce++], upadek: false, zaw: o.zaw });
  b.wynik.forEach((w, i) => {
    m.punkty[w.numer >= 9 ? 'gosp' : 'gosc'] += w.pkt;
    (m.indyw[w.zaw.id] = m.indyw[w.zaw.id] || []).push(w.upadek ? 'U' : w.pkt);
    (m.biegiZaw[w.zaw.id] = m.biegiZaw[w.zaw.id] || []).push(nr);
    // punkt bonusowy: zawodnik tuż za partnerem z drużyny, oba przejazdy ukończone
    // Bonus przysługuje tylko punktującemu — za ostatnie miejsce nie ma czego premiować.
    if (i > 0 && !w.upadek && w.pkt > 0) {
      const przed = b.wynik[i - 1];
      if (!przed.upadek && (przed.numer >= 9) === (w.numer >= 9))
        m.bonusy[w.zaw.id] = (m.bonusy[w.zaw.id] || 0) + 1;
    }
  });
  // Wykluczony za taśmę nie jechał, ale musi się pojawić w wynikach z literą T.
  const wt = m.tasma[nr];
  if (wt) {
    b.wynik.push({ numer: wt.numer, pkt: 0, tasma: true, zaw: wt.zaw });
    (m.indyw[wt.zaw.id] = m.indyw[wt.zaw.id] || []).push('T');
    (m.biegiZaw[wt.zaw.id] = m.biegiZaw[wt.zaw.id] || []).push(nr);
  }
  m.bieg = nr + 1;
  if (nr >= 15) m.skonczony = true;
}
const strataMoja = m => m.jestemGospodarzem ? m.punkty.gosc - m.punkty.gosp : m.punkty.gosp - m.punkty.gosc;
const mojaDruzyna = m => m.jestemGospodarzem ? m.gosp : m.gosc;

/* ---------- obsada biegów nominowanych ---------- */
function nominujAutomat(m, druzyna, pula) {
  const numery = pula || (druzyna === 'gosp' ? [9, 10, 11, 12, 13, 14, 15] : [1, 2, 3, 4, 5, 6, 7]);
  return numery
    .map(n => ({ n, pkt: (m.indyw[zawodnikNr(m, n).id] || []).reduce((a, c) => a + (Number(c) || 0), 0), s: zawodnikNr(m, n).s }))
    .sort((a, b) => (b.pkt * 3 + b.s / 20) - (a.pkt * 3 + a.s / 20))
    .slice(0, 2).map(x => x.n);
}
// Zawodnicy jednej drużyny nigdy nie stoją na sąsiednich polach — sprawdzone na
// wszystkich 13 biegach oficjalnego programu. Dozwolone są tylko dwa układy:
// gospodarze na A+C albo na B+D. Bieg 14 otwiera gość, bieg 15 gospodarz.
function ustawNominowany(m, nr, gospPara, goscPara) {
  const b = m.program[nr - 1];
  b.gosp = gospPara; b.gosc = goscPara;
  const pola = ['A', 'B', 'C', 'D'];
  const kolejni = (nr % 2 === 0)
    ? [goscPara[0], gospPara[0], goscPara[1], gospPara[1]]
    : [gospPara[0], goscPara[0], gospPara[1], goscPara[1]];
  b.pola = {};
  kolejni.forEach((n, i) => b.pola[n] = pola[i]);
}

// Kontrola spójności: zwraca true, gdy w biegu drużyny stoją naprzemiennie.
function polaNaprzemienne(b) {
  if (!b || !b.gosp) return true;
  const uk = ['A', 'B', 'C', 'D'].map(p => {
    const n = [...b.gosp, ...b.gosc].find(x => b.pola[x] === p);
    return n >= 9 ? 'G' : 'g';
  }).join('');
  return uk === 'GgGg' || uk === 'gGgG';
}

/* ======================= SYMULACJA BIEGU BEZ RYSOWANIA ======================= */
// Ten sam silnik co jazda gracza — inaczej wyniki symulowane nie byłyby spójne z jeżdżonymi.
function symulujBieg(m, nr) {
  const obs = obsadaBiegu(m, nr);
  const surf = new Surface((nr * 977 + 13) & 0x7fffffff);
  surf.preWear(STANY_TORU[stanToruBiegu(nr)]);
  const bikes = obs.map((o, i) => {
    const par = parametryZaw(o.zaw);
    const b = new Bike({ id: i, skill: par.skill, style: par.style, aggro: par.aggro, adapt: par.adapt, assist: 1 });
    const p = fromTrack(TRK.START_S - 0.7, gate(o.pole));
    b.x = p.x; b.z = p.z; b.psi = Math.atan2(p.hx, p.hz);
    b.clutch = 0; b.we = rpm2rad(par.obrStartu);
    b.lap = -1; b.prog = raceProgress(toTrack(b.x, b.z).s); b.lapTimes = []; b.lastLapT = 0;
    b.reakcja = par.reakcja; b.obs = o; o.upadek = false; b.tol = par.tolSlizgu;
    return b;
  });
  const dt = 1 / 150, meta = [];
  let t = 0;
  for (let k = 0; k < 150 * 150; k++) {
    t += dt;
    for (const b of bikes) {
      let inp;
      if (t < 0.5) inp = { throttle: 0.85, steer: 0, clutch: true };
      else {
        // AI liczone co trzeci krok fizyki (50 Hz) — w jeździe gracza jest tak samo,
        // a liczenie go 150 razy na sekundę potroiłoby koszt symulacji
        if (k % 3 === 0 || !b.symInp) {
          b.symInp = aiControl(b, bikes, surf, t, { pace: 1, dt: dt * 3 });
        }
        inp = b.symInp;
        if (t - 0.5 < b.reakcja) inp.clutch = true;
        else if (t - 0.5 < b.reakcja + 0.3) inp.throttle = 1;
        else inp.clutch = false;
      }
      inp.launchRate = 3.1;
      b.step(dt, inp, surf, t);
      if (b.down > 0 && !b.upadl) { b.upadl = true; b.down = 999; b.obs.upadek = true; }
      if (b.lap === 0 && !b._z) { b._z = true; b.lapTimes = []; b.lastLapT = t; }
      if (b.lap >= G.okrazen && !b.meta) { b.meta = t; meta.push(b); }
    }
    if (meta.length === bikes.length) break;
  }
  const reszta = bikes.filter(b => !b.meta).sort((a, b) => (a.upadl ? 1 : 0) - (b.upadl ? 1 : 0) || b.total - a.total);
  return [...meta, ...reszta].map(b => b.obs);
}

/* ======================= EKRANY TRYBU MECZU ======================= */
function pokazEkran(id) {
  ['menu', 'wyborDruzyn', 'ekranProgramu', 'planszaBiegu',
   'wynikBiegu', 'kartaMeczu', 'decyzjaTrenera'].forEach(x => {
    const e = el(x); if (e) e.hidden = (x !== id);
  });
  el('hud').hidden = (id !== null);
  if (id) dopasujMenu();
}
function ukryjEkrany() { pokazEkran(null); }

const herb = k => `<span class="herb" style="--b1:${k.b1};--b2:${k.b2}">${k.sk}</span>`;

function rysujWyborDruzyn() {
  const lista = liga => KLUBY.filter(k => k.lg === liga).map(k => `
    <button class="klub" data-id="${k.id}" style="--b1:${k.b1};--b2:${k.b2}">
      ${herb(k)}<u>${k.n}</u><em>${k.dl} m</em></button>`).join('');
  el('kolGosp').innerHTML = Object.keys(LIGI).map(l =>
    `<div class="ligaNag">${LIGI[l]}</div>${lista(l)}`).join('');
  el('kolGosc').innerHTML = el('kolGosp').innerHTML;
  const zazn = (kol, id) => kol.querySelectorAll('.klub').forEach(b =>
    b.classList.toggle('wybrany', b.dataset.id === id));
  el('kolGosp').querySelectorAll('.klub').forEach(b => b.addEventListener('click', () => {
    G.wyborGosp = b.dataset.id; zazn(el('kolGosp'), G.wyborGosp); odswiezWyborDruzyn();
  }));
  el('kolGosc').querySelectorAll('.klub').forEach(b => b.addEventListener('click', () => {
    G.wyborGosc = b.dataset.id; zazn(el('kolGosc'), G.wyborGosc); odswiezWyborDruzyn();
  }));
  G.wyborGosp = G.wyborGosp || KLUBY[0].id;
  G.wyborGosc = G.wyborGosc || KLUBY[1].id;
  zazn(el('kolGosp'), G.wyborGosp); zazn(el('kolGosc'), G.wyborGosc);
  odswiezWyborDruzyn();
}
function odswiezWyborDruzyn() {
  const a = klubPo(G.wyborGosp), b = klubPo(G.wyborGosc);
  const ok = a && b && a.id !== b.id;
  el('dalejDruzyny').disabled = !ok;
  const inf = el('infoMecz');
  if (!ok) { inf.innerHTML = '<span class="ostrz">Wybierz dwie różne drużyny</span>'; return; }
  const bm = barwyMeczu(a, b);
  const zmiana = bm.gosc !== b.b1
    ? '<br><span class="ostrz">Barwy zbyt podobne — gość pojedzie w barwie dodatkowej</span>' : '';
  const roznaLiga = a.lg !== b.lg ? '<br><span class="ostrz">Mecz między ligami — towarzyski</span>' : '';
  inf.innerHTML = `<b>${a.n}</b> podejmuje <b>${b.n}</b><br>
    tor ${a.dl} m · ${a.sz} m szerokości${a.st ? ' · ' + a.st : ''}${zmiana}${roznaLiga}`;
}

/* ---------- ekran tabeli biegowej: centrum meczu ---------- */
function rysujProgram() {
  const m = G.mecz;
  el('tytulProgramu').innerHTML =
    `${herb(m.gosp)}<b>${m.gosp.n}</b> <s>${m.punkty.gosp}</s> : <s>${m.punkty.gosc}</s> <b>${m.gosc.n}</b>${herb(m.gosc)}`;
  const wiersze = m.program.map(b => {
    const moj = b.gosp && mojeNumeryWBiegu(m, b.nr).length > 0;
    const gotowy = !!b.wynik;
    const biezacy = b.nr === m.bieg;
    let obsada = '<em class="doUstal">obsada po 13. biegu</em>';
    if (b.gosp) {
      const kaski = { [b.gosp[0]]: 'C', [b.gosp[1]]: 'N', [b.gosc[0]]: 'B', [b.gosc[1]]: 'Z' };
      obsada = [...b.gosp, ...b.gosc].map(n => {
        const z = zawodnikNr(m, n, b.nr);
        const wy = gotowy ? b.wynik.find(w => w.numer === n) : null;
        const pkt = wy ? (wy.tasma ? 'T' : wy.upadek ? 'U' : wy.pkt) : null;
        const mojZ = (n >= 9) === m.jestemGospodarzem;
        return `<span class="wZaw${mojZ ? ' ja' : ''}">
          <i style="background:${KASK_KOL[kaski[n]]}"></i>${b.pola[n]}
          <u>${z.n.split(' ').pop()}</u>${gotowy ? `<b>${pkt}</b>` : ''}</span>`;
      }).join('');
    }
    return `<div class="wBieg${biezacy ? ' teraz' : ''}${gotowy ? ' zrobiony' : ''}${moj ? ' mojBieg' : ''}">
      <s>${b.nr}</s>${obsada}</div>`;
  }).join('');
  el('listaProgramu').innerHTML = wiersze;
  if (G.widokKarta) rysujKarteProgramu();
  const b = m.program[m.bieg - 1];
  const kon = m.skonczony || m.bieg > 15;
  el('akcjaBiegu').innerHTML = kon
    ? '<button id="doKarty" class="opcja gl">Karta wyników</button>'
    : `<button id="jedzBieg" class="opcja gl">Bieg ${m.bieg} — wybierz zawodnika</button>
       <button id="symBieg" class="opcja">Przesymuluj</button>`;
  if (el('doKarty')) el('doKarty').onclick = () => { rysujKarte(); pokazEkran('kartaMeczu'); };
  if (el('jedzBieg')) el('jedzBieg').onclick = () => planszaPrzedBiegiem();
  if (el('symBieg')) el('symBieg').onclick = () => rozegrajSymulacje();
  const strata = strataMoja(m);
  const mojaDr = m.jestemGospodarzem ? 'gosp' : 'gosc';
  el('paskDecyzji').innerHTML = (!kon && strata >= 6 && m.rezerwaLicznik[mojaDr] < 3 && m.program[m.bieg - 1] && m.program[m.bieg - 1].gosp)
    ? `<button id="rezerwaBtn" class="opcja">Rezerwa taktyczna — bieg ${m.bieg} (tracisz ${strata} pkt, zostały ${3 - m.rezerwaLicznik[mojaDr]})</button>` : '';
  if (el('rezerwaBtn')) el('rezerwaBtn').onclick = () => decyzjaRezerwa();
}

function przejdzDalej() {
  const m = G.mecz;
  if ((m.bieg === 14 || m.bieg === 15) && m.program[m.bieg - 1] && !m.program[m.bieg - 1].gosp) {
    decyzjaNominowane(m.bieg); return;
  }
  if (m.bieg > 15) { rysujKarte(); pokazEkran('kartaMeczu'); return; }
  rysujProgram(); pokazEkran('ekranProgramu');
}

/* ---------- taśma w meczu: wykluczenie i junior w zastępstwie ---------- */
// Sędzia wyklucza od razu, a drużyna może wstawić w to miejsce juniora.
// Wykluczony dostaje w wynikach literę T i zero punktów, junior jedzie za niego.
function tasmaWMeczu(b) {
  const m = G.mecz, nr = m.bieg;
  const numer = b.numerMeczowy;
  const zaw = zawodnikNr(m, numer, nr);
  m.tasma[nr] = { numer, zaw };   // jeden wpis na bieg — powtórne dotknięcie go nadpisze
  const mojaStrona = (numer >= 9) === m.jestemGospodarzem;
  if (mojaStrona) wybierzJuniora(numer);
  else {
    const j = juniorzyDoZastepstwa(m, nr, numer, false);
    if (j.length) {
      const naj = j.sort((x, y) => zawodnikNr(m, y, nr).s - zawodnikNr(m, x, nr).s)[0];
      (m.zamiany[nr] = m.zamiany[nr] || {})[numer] = naj;
    }
    restartBiegu();
  }
}

// Juniorzy i rezerwa, którzy nie jadą już w tym biegu.
function juniorzyDoZastepstwa(m, nr, wykluczony, mojaStrona) {
  const gospodarz = (wykluczony >= 9);
  const klub = gospodarz ? m.gosp : m.gosc;
  const baza = gospodarz ? 8 : 0;
  const b2 = m.program[nr - 1];
  const wBiegu = b2 && b2.gosp ? [...b2.gosp, ...b2.gosc] : [];
  void mojaStrona;
  return klub.z
    .filter(z => z.r === 'j' || z.r === 'rezerwa')
    .map(z => baza + z.p)
    .filter(n2 => n2 !== wykluczony && !wBiegu.includes(n2));
}

function wybierzJuniora(wykluczony) {
  const m = G.mecz, nr = m.bieg;
  const zaw = zawodnikNr(m, wykluczony, nr);
  const lista = juniorzyDoZastepstwa(m, nr, wykluczony, true);
  el('dtTytul').textContent = 'Taśma — wykluczenie';
  el('dtOpis').innerHTML = `<b>${zaw.n}</b> dotknął taśmy i sędzia wykluczył go z biegu ${nr}.
    W wynikach dostanie <b>T</b> i zero punktów. Możesz wstawić w jego miejsce juniora.`;
  el('dtOpcje').innerHTML = lista.map(n2 => {
    const z = zawodnikNr(m, n2, nr);
    return `<button class="opcja dtOpcja" data-nr="${n2}">${z.n}
      <small>nr ${n2} · siła ${z.s} · ${z.r === 'j' ? 'junior' : 'rezerwa'}</small></button>`;
  }).join('') + '<button class="opcja dtOpcja" data-nr="0">Jedziemy w trójkę</button>';
  el('dtOpcje').querySelectorAll('.dtOpcja').forEach(btn => btn.onclick = () => {
    const n2 = +btn.dataset.nr;
    if (n2) (m.zamiany[nr] = m.zamiany[nr] || {})[wykluczony] = n2;
    else G.wykluczonyNumer = wykluczony;     // brak zastępcy: bieg w trzech
    ukryjEkrany(); el('hud').hidden = false; resize();
    restartBiegu();
  });
  el('hud').hidden = true;
  pokazEkran('decyzjaTrenera');
}

/* ---------- karta punktów: standardowy program meczu ---------- */
function kartaZespolu(m, klub, baza, mojaStrona) {
  const naglowek = '<tr><th>Nr</th><th>Zawodnik</th>' +
    [1, 2, 3, 4, 5].map(i => `<th>${i}</th>`).join('') +
    '<th>Suma</th><th>14</th><th>15</th><th>Razem</th><th>B</th></tr>';
  const wiersze = klub.z.filter(z => z.p <= 8).map(z => {
    const pkt = m.indyw[z.id] || [], biegi = m.biegiZaw[z.id] || [];
    const zasadnicze = [], nom = { 14: '', 15: '' };
    pkt.forEach((v, i) => { const nr = biegi[i];
      if (nr >= 14) nom[nr] = v; else zasadnicze.push(v); });
    const kom = v => (v === 'U' || v === 'T') ? `<span class="kpU">${v}</span>` : (v === '' || v === undefined ? '' : v);
    const suma = zasadnicze.reduce((a, c) => a + (Number(c) || 0), 0);
    const razem = suma + (Number(nom[14]) || 0) + (Number(nom[15]) || 0);
    const b = m.bonusy[z.id] || 0;
    return `<tr class="${mojaStrona ? 'jaDr' : ''}">
      <td class="nr">${baza + z.p}</td><td class="nz">${z.n}${z.r === 'j' ? ' (J)' : ''}</td>
      ${[0, 1, 2, 3, 4].map(i => `<td>${kom(zasadnicze[i])}</td>`).join('')}
      <td class="sm">${suma || ''}</td>
      <td class="nom">${kom(nom[14])}</td><td class="nom">${kom(nom[15])}</td>
      <td class="sm">${razem || ''}</td><td>${b || ''}</td></tr>`;
  }).join('');
  return `<table class="kpTab"><caption>${herb(klub)} ${klub.n}</caption>${naglowek}${wiersze}</table>`;
}
function rysujKarteProgramu() {
  const m = G.mecz;
  el('kartaProgramu').innerHTML =
    kartaZespolu(m, m.gosp, 8, m.jestemGospodarzem) +
    kartaZespolu(m, m.gosc, 0, !m.jestemGospodarzem);
}
function przelaczWidok(karta) {
  G.widokKarta = karta;
  el('listaProgramu').hidden = karta;
  el('kartaProgramu').hidden = !karta;
  el('widokProgram').setAttribute('aria-pressed', !karta);
  el('widokKarta').setAttribute('aria-pressed', karta);
  if (karta) rysujKarteProgramu();
}

/* ---------- symulacja z planszą wyniku ---------- */
function rozegrajSymulacje() {
  const m = G.mecz, nr = m.bieg;
  el('symLicze').hidden = false;
  setTimeout(() => {
    const kol = symulujBieg(m, nr);
    zapiszWynik(m, nr, kol);
    el('symLicze').hidden = true;
    pokazWynikBiegu(nr, kol, false);
  }, 30);
}

function pokazWynikBiegu(nr, kolejnosc, jechalem) {
  const m = G.mecz;
  const b = m.program[nr - 1];
  const kaski = { [b.gosp[0]]: 'C', [b.gosp[1]]: 'N', [b.gosc[0]]: 'B', [b.gosc[1]]: 'Z' };
  el('wbTytul').textContent = `Bieg ${nr}`;
  el('wbLista').innerHTML = kolejnosc.map((o, i) => {
    const w = b.wynik[i];
    // Ten sam warunek co przy zapisie: zero punktów to brak bonusu, choćby
    // zawodnik finiszował tuż za partnerem. Wcześniej plansza pokazywała +1,
    // którego księgowanie i tak nie naliczało.
    const bonus = i > 0 && !w.upadek && !w.tasma && w.pkt > 0
      && !b.wynik[i - 1].upadek && (b.wynik[i - 1].numer >= 9) === (w.numer >= 9);
    return `<tr class="${((o.numer >= 9) === m.jestemGospodarzem) ? 'ja' : ''}">
      <td class="m">${i + 1}</td>
      <td class="c"><i style="background:${KASK_KOL[kaski[o.numer]]}"></i></td>
      <td>${o.zaw.n}</td>
      <td class="k">${o.numer >= 9 ? m.gosp.sk : m.gosc.sk}</td>
      <td class="p">${w.tasma ? '<span class="upadekU">T</span>' :
        w.upadek ? '<span class="upadekU">U</span>' : w.pkt}${bonus ? '<sup>+1</sup>' : ''}</td></tr>`;
  }).join('');
  el('wbWynik').innerHTML = `${m.gosp.sk} <b>${m.punkty.gosp}</b> : <b>${m.punkty.gosc}</b> ${m.gosc.sk}`;
  pokazEkran('wynikBiegu');
}

/* ---------- plansza przed biegiem gracza ---------- */
function planszaPrzedBiegiem() {
  const m = G.mecz, nr = m.bieg;
  const obs = obsadaBiegu(m, nr);
  el('pbTytul').textContent = `Bieg ${nr} z 15`;
  el('pbWynik').innerHTML = `${m.gosp.sk} <b>${m.punkty.gosp}</b> : <b>${m.punkty.gosc}</b> ${m.gosc.sk}`;
  const moje = mojeNumeryWBiegu(m, nr);
  el('pbLista').innerHTML = obs.slice().sort((a, b2) => a.pole - b2.pole).map(o => {
    const mojZ = moje.includes(o.numer);
    return `<div class="pbZaw${mojZ ? ' mojaDr' : ''}">
      <div class="pbKask" style="background:${KASK_KOL[o.kask]}">${'ABCD'[o.pole]}</div>
      <div class="pbOpis"><b>${o.zaw.n}</b>
        <em>${o.gospodarz ? m.gosp.n : m.gosc.n} · nr ${o.numer} · ${o.zaw.kr}
        · siła ${o.zaw.s} · start ${o.zaw.st}</em></div>
      ${mojZ ? '<button class="opcja wybierzZaw" data-nr="' + o.numer + '">Jadę nim</button>' : ''}
    </div>`;
  }).join('');
  el('pbAkcje').innerHTML =
    '<button id="pbSymuluj" class="opcja">Przesymuluj ten bieg</button>' +
    '<button id="pbWroc" class="opcja">Tabela biegowa</button>';
  el('pbLista').querySelectorAll('.wybierzZaw').forEach(btn => btn.onclick = () => {
    m.mojNumer = +btn.dataset.nr;
    G.wykluczonyNumer = null;
    ukryjEkrany(); el('hud').hidden = false; resize();
    budujBieg(); Audio_.start();
  });
  el('pbSymuluj').onclick = () => { pokazEkran('ekranProgramu'); rozegrajSymulacje(); };
  el('pbWroc').onclick = () => { rysujProgram(); pokazEkran('ekranProgramu'); };
  pokazEkran('planszaBiegu');
}

/* ---------- decyzje trenerskie ---------- */
function decyzjaRezerwa() {
  const m = G.mecz;
  const mojaDr = m.jestemGospodarzem ? 'gosp' : 'gosc';
  const baza = m.jestemGospodarzem ? 8 : 0;
  const klub = m.jestemGospodarzem ? m.gosp : m.gosc;
  const nr = m.bieg;
  const wBiegu = mojeNumeryWBiegu(m, nr);
  const zostalo = 3 - m.rezerwaLicznik[mojaDr];
  el('dtTytul').textContent = 'Rezerwa taktyczna';
  el('dtOpis').innerHTML = `Tracisz ${strataMoja(m)} punktów. Zmiana dotyczy biegu ${nr}.
    Zostały Ci ${zostalo} z trzech zmian w meczu. Kogo zdejmujesz?`;
  el('dtOpcje').innerHTML = wBiegu.map(n => {
    const z = zawodnikNr(m, n, nr);
    const pkt = (m.indyw[z.id] || []).reduce((a, c) => a + (Number(c) || 0), 0);
    return `<button class="opcja dtOpcja" data-nr="${n}">${z.n}<small>nr ${n} · ${pkt} pkt w meczu</small></button>`;
  }).join('') + '<button class="opcja dtOpcja" data-nr="0">Rezygnuję</button>';
  el('dtOpcje').querySelectorAll('.dtOpcja').forEach(btn => btn.onclick = () => {
    const n = +btn.dataset.nr;
    if (!n) { przejdzDalej(); return; }
    wybierzZastepce(n);
  });
  pokazEkran('decyzjaTrenera');
}

// Drugi krok: kto wchodzi. Każdy zawodnik może wejść jako zastępca tylko raz w meczu.
function wybierzZastepce(zdejmowany) {
  const m = G.mecz;
  const mojaDr = m.jestemGospodarzem ? 'gosp' : 'gosc';
  const baza = m.jestemGospodarzem ? 8 : 0;
  const klub = m.jestemGospodarzem ? m.gosp : m.gosc;
  const nr = m.bieg;
  const wBiegu = mojeNumeryWBiegu(m, nr);
  const dostepni = klub.z.filter(z => {
    const numer = baza + z.p;
    return !wBiegu.includes(numer) && !m.uzyciZastepcy[mojaDr].includes(numer);
  });
  el('dtTytul').textContent = 'Kto wchodzi?';
  if (!dostepni.length) {
    el('dtOpis').innerHTML = 'Nie ma już wolnego zawodnika — każdy z pozostałych wchodził wcześniej.';
    el('dtOpcje').innerHTML = '<button class="opcja dtOpcja" data-nr="0">Wróć</button>';
  } else {
    el('dtOpis').innerHTML = `Za nr ${zdejmowany} w biegu ${nr}. Każdy zawodnik może wejść
      w zastępstwie tylko raz w meczu.`;
    el('dtOpcje').innerHTML = dostepni.map(z => {
      const numer = baza + z.p;
      const pkt = (m.indyw[z.id] || []).reduce((a, c) => a + (Number(c) || 0), 0);
      return `<button class="opcja dtOpcja" data-nr="${numer}">${z.n}
        <small>nr ${numer} · siła ${z.s} · ${pkt} pkt w meczu</small></button>`;
    }).join('') + '<button class="opcja dtOpcja" data-nr="0">Rezygnuję</button>';
  }
  el('dtOpcje').querySelectorAll('.dtOpcja').forEach(btn => btn.onclick = () => {
    const numer = +btn.dataset.nr;
    if (numer) {
      (m.zamiany[nr] = m.zamiany[nr] || {})[zdejmowany] = numer;
      m.uzyciZastepcy[mojaDr].push(numer);
      m.rezerwaLicznik[mojaDr]++;
    }
    przejdzDalej();
  });
  pokazEkran('decyzjaTrenera');
}

// Obsadę każdego biegu nominowanego zgłasza się osobno: 14. po trzynastym,
// 15. dopiero po czternastym. Wcześniej wybór dwóch zawodników wypełniał oba
// naraz, więc gracz nie miał wpływu na ostatni wyścig meczu.
function decyzjaNominowane(nr) {
  const m = G.mecz;
  const przeciw = m.jestemGospodarzem ? 'gosc' : 'gosp';
  const wszyscy = m.jestemGospodarzem ? [9, 10, 11, 12, 13, 14, 15] : [1, 2, 3, 4, 5, 6, 7];
  // kto jechał w biegu 14, nie wchodzi do 15 — inaczej wybór byłby zawsze ten sam
  const juzByli = (nr === 15 && m.program[13].gosp)
    ? [...m.program[13].gosp, ...m.program[13].gosc] : [];
  const moje = wszyscy.filter(n => !juzByli.includes(n));
  el('dtTytul').textContent = `Bieg nominowany ${nr}`;
  el('dtOpis').innerHTML = nr === 14
    ? 'Po 13. biegu trenerzy zgłaszają obsadę. Wybierz dwóch zawodników do biegu 14 — obsadę piętnastego podasz po nim.'
    : 'Ostatni bieg meczu. Zawodnicy z biegu 14 już nie startują, wybierz dwóch spośród pozostałych.';
  G.nomWybor = [];
  el('dtOpcje').innerHTML = moje.map(n => {
    const z = zawodnikNr(m, n);
    const pkt = (m.indyw[z.id] || []).reduce((a, c) => a + (Number(c) || 0), 0);
    return `<button class="opcja dtOpcja" data-nr="${n}">${z.n}<small>nr ${n} · ${pkt} pkt · siła ${z.s}</small></button>`;
  }).join('');
  el('dtOpcje').querySelectorAll('.dtOpcja').forEach(b => b.onclick = () => {
    const n = +b.dataset.nr;
    if (G.nomWybor.includes(n)) return;
    G.nomWybor.push(n); b.classList.add('wybrany');
    if (G.nomWybor.length < 2) return;
    const pulaBot = (przeciw === 'gosp' ? [9, 10, 11, 12, 13, 14, 15] : [1, 2, 3, 4, 5, 6, 7])
      .filter(x => !juzByli.includes(x));
    const bot = nominujAutomat(m, przeciw, pulaBot);
    if (m.jestemGospodarzem) ustawNominowany(m, nr, G.nomWybor, bot);
    else ustawNominowany(m, nr, bot, G.nomWybor);
    rysujProgram(); pokazEkran('ekranProgramu');
  });
  pokazEkran('decyzjaTrenera');
}

/* ---------- karta wyników meczu ---------- */
function rysujKarte() {
  const m = G.mecz;
  const wG = m.punkty.gosp, wS = m.punkty.gosc;
  el('kmTytul').innerHTML = `${m.gosp.n} <b>${wG}</b> : <b>${wS}</b> ${m.gosc.n}`;
  const tabela = (klub, baza) => klub.z.filter(z => z.p <= 8).map(z => {
    const p = m.indyw[z.id] || [];
    const bon = m.bonusy[z.id] || 0;
    const suma = p.reduce((a, c) => a + (Number(c) || 0), 0);
    const moj = (baza === 8) === m.jestemGospodarzem;
    return `<tr class="${moj ? 'ja' : ''}"><td class="nr">${baza + z.p}</td><td>${z.n}</td>
      <td class="bg">${p.join(',') || '—'}</td>
      <td class="sm">${suma}${bon ? '+' + bon : ''}</td></tr>`;
  }).join('');
  el('kmGosp').innerHTML = `<caption>${herb(m.gosp)} ${m.gosp.n}</caption>` + tabela(m.gosp, 8);
  el('kmGosc').innerHTML = `<caption>${herb(m.gosc)} ${m.gosc.n}</caption>` + tabela(m.gosc, 0);
  const mojePkt = m.jestemGospodarzem ? wG : wS;
  const ichPkt = m.jestemGospodarzem ? wS : wG;
  el('kmOpis').innerHTML = mojePkt > ichPkt
    ? `Twoja drużyna wygrała ${mojePkt}:${ichPkt}.`
    : (mojePkt === ichPkt ? `Remis ${mojePkt}:${ichPkt}.` : `Porażka ${mojePkt}:${ichPkt}.`);
}

/* ======================= ZAWODNIK Z MODELU ======================= */
// Model wczytuje się w tle. Dopóki nie jest gotowy — albo gdyby się nie wczytał —
// gra używa zawodnika składanego z brył, więc nic nie przestaje działać.
G.model3d = false;
if (typeof Zawodnik3D !== 'undefined') {
  Zawodnik3D.wczytaj('modele/zawodnik.gltf', 'modele/tekstury/faktura.png', 'modele/tekstury/normalna.png')
    .then(() => { G.model3d = true; console.log('zawodnik 3D gotowy'); })
    .catch(e => console.warn('zawodnik 3D niedostępny, zostaje model z brył:', e && e.message));
}

/* ======================= PĘTLA GŁÓWNA ======================= */
let ostatni = performance.now(), malujT = 0;
function petla(teraz) {
  requestAnimationFrame(petla);
  let dt = (teraz - ostatni) / 1000; ostatni = teraz;
  dt = Math.max(0, Math.min(dt, 0.05));   // odporność na skoki zegara

  if (G.faza === 'menu') {
    kameraMenu(dt);
    renderer.render(scena, kam);
    return;
  }
  if (!G.pauza) {
    aktualizujFaze(dt);
    if (G.faza !== 'wynik' && G.faza !== 'tasma') {
      akumulator += dt;
      let n = 0;
      while (akumulator >= DT && n < 12) { G.t += DT; krokFizyki(DT); akumulator -= DT; n++; }
      if (n >= 12) akumulator = 0;
    }
    aktualizujModele(dt);
    malujT -= dt;
    if (malujT <= 0) { malujT = 0.28; malujTor(); }
    Audio_.aktualizuj();
  }
  const cel = G.gracz && G.gracz.down <= 0 ? G.gracz : (kolejnosc()[0] || G.gracz);
  if (cel) {
    if (G.faza === 'prezentacja') {
      const a = G.tFazy * 0.55;
      const c = fromTrack(TRK.START_S + 6, 0);
      kam.up.set(0, 1, 0);
      kam.position.set(c.x + Math.cos(a) * 16, 4.6 + Math.sin(a * 1.4) * 1.4, c.z + Math.sin(a) * 16);
      kam.lookAt(c.x, 1.0, c.z);
      kam.fov = fovZPoziomego(74); kam.updateProjectionMatrix();
    } else ustawKamere(cel, dt);
  }
  aktualizujHUD(dt);
  slonce.target.position.set(cel ? cel.x : 0, 0, cel ? cel.z : 0);
  slonce.position.set((cel ? cel.x : 0) + 46, 92, (cel ? cel.z : 0) + 38);
  renderer.render(scena, kam);
}

/* ======================= MENU ======================= */
function budujMenu() {
  const c = el('pola');
  c.innerHTML = ZAWODNICY.map((z, i) => {
    const jasny = (i === 2 || i === 3) ? ' jasny' : '';
    const stat = Object.entries(z.stat).map(([k, v]) =>
      `<div class="stat"><span>${k}</span><div class="pasek"><i style="width:${Math.round(v * 100)}%"></i></div></div>`).join('');
    return `<button class="pole${jasny}" data-i="${i}" style="--kask:${KASKI[i]}">
      <div class="kask"><b>${i + 1}</b><i>POLE ${POLA[i]}</i></div>
      <div class="tresc">
        <div class="imie">${z.imie}</div>
        <div class="opis">${z.opis}</div>
        ${stat}
      </div></button>`;
  }).join('');
  c.querySelectorAll('.pole').forEach(p => p.addEventListener('click', () => {
    G.wybor = +p.dataset.i;
    c.querySelectorAll('.pole').forEach(q => q.classList.toggle('wybrany', q === p));
  }));
  c.querySelector('.pole').click();

  const grupy = { poziom: 'poziom', tor: 'stanToru', okrazenia: 'okrazen' };
  for (const id in grupy) {
    const box = el(id);
    box.querySelectorAll('.opcja').forEach(o => o.addEventListener('click', () => {
      box.querySelectorAll('.opcja').forEach(q => q.setAttribute('aria-pressed', q === o ? 'true' : 'false'));
      G[grupy[id]] = +o.dataset.v;
    }));
  }
}
function odpalGre(tryb) {
  G.tryb = tryb;
  el('menu').hidden = true; el('hud').hidden = false; resize();
  G.wykluczeni = []; G.ostrzezenie = false;
  budujBieg();
  Audio_.start();
}
el('jedziemy').addEventListener('click', () => odpalGre('bieg'));
el('meczBtn').addEventListener('click', () => { G.tryb = 'mecz'; rysujWyborDruzyn(); pokazEkran('wyborDruzyn'); });
el('wrocDruzyny').addEventListener('click', () => { G.tryb = 'bieg'; pokazEkran('menu'); });
el('dalejDruzyny').addEventListener('click', () => {
  G.klubGosp = klubPo(G.wyborGosp);          // barwy i miasto muszą być znane przed przebudową
  G.torDoPrzebudowy = true;
  ustawTor(klubPo(G.wyborGosp).dl, klubPo(G.wyborGosp).sz);
  if (G.torDoPrzebudowy) zbudujSwiat();      // gdy geometria się nie zmieniła, i tak odświeżamy oprawę
  malujTor();
  G.mecz = nowyMecz(G.wyborGosp, G.wyborGosc, G.jestemGospodarzem);
  rysujProgram(); pokazEkran('ekranProgramu');
});
el('stronaGosp').addEventListener('click', () => { G.jestemGospodarzem = true; przelaczStrone(); });
el('stronaGosc').addEventListener('click', () => { G.jestemGospodarzem = false; przelaczStrone(); });
function przelaczStrone() {
  el('stronaGosp').setAttribute('aria-pressed', G.jestemGospodarzem);
  el('stronaGosc').setAttribute('aria-pressed', !G.jestemGospodarzem);
  odswiezWyborDruzyn();
}
el('dokonczBtn').addEventListener('click', () => dokonczBieg());
el('widokProgram').addEventListener('click', () => przelaczWidok(false));
el('widokKarta').addEventListener('click', () => przelaczWidok(true));
el('wbDalej').addEventListener('click', () => przejdzDalej());
const doMenuZMeczu = () => {
  G.tryb = 'bieg'; G.mecz = null; G.klubGosp = null; G.torDoPrzebudowy = true;
  ustawTor(TOR_BAZOWY.dl, TOR_BAZOWY.sz);
  if (G.torDoPrzebudowy) zbudujSwiat();
  malujTor(); pokazEkran('menu');
};
el('kmMenu').addEventListener('click', doMenuZMeczu);
el('programMenu').addEventListener('click', doMenuZMeczu);
el('trening').addEventListener('click', () => { G.telem = true; odpalGre('trening'); });
el('powtorz').addEventListener('click', () => { G.wykluczeni = []; G.ostrzezenie = false; restartBiegu(); });
el('doMenu').addEventListener('click', () => { G.tryb = 'bieg'; });
el('doMenu').addEventListener('click', doMenu);

/* ---------- sterowanie dotykowe ---------- */
if (matchMedia('(pointer:coarse)').matches) {
  const d = el('dotyk'); d.hidden = false; el('hud').classList.add('dotykowy');
  d.querySelectorAll('button').forEach(bt => {
    const k = bt.dataset.k;
    const on = e => { e.preventDefault(); dotyk[k] = 1; };
    const off = e => { e.preventDefault(); dotyk[k] = 0; };
    bt.addEventListener('pointerdown', on); bt.addEventListener('pointerup', off);
    bt.addEventListener('pointercancel', off); bt.addEventListener('pointerleave', off);
  });
}

/* ======================= START ======================= */
function boot() {
  resize();
  zbudujSwiat();
  malujTor();
  budujMenu();
  el('ladowanie').remove();
  dopasujMenu();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(dopasujMenu);
  // treść menu może się przeliczyć po wczytaniu krojów pisma
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => dopasujMenu());
    const wr = document.querySelector('.wrap'); if (wr) ro.observe(wr);
  }
  requestAnimationFrame(petla);
}
if (typeof THREE === 'undefined') {
  document.getElementById('ladowanie').innerHTML =
    '<div style="text-align:center;line-height:1.7;letter-spacing:0;font-family:Barlow,sans-serif">' +
    'Nie udało się wczytać biblioteki 3D.<br><small style="opacity:.7">Gra pobiera Three.js z sieci — sprawdź połączenie i odśwież stronę.</small></div>';
} else {
  // pierwsze malowanie toru wymaga istniejącej nawierzchni
  G.surf = new Surface(1); G.surf.preWear(STANY_TORU[G.stanToru]);
  boot();
}
