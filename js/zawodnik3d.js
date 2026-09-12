/* =====================================================================
   ZAWODNIK Z MODELU glTF

   Zastępuje zawodnika składanego z brył. Model wczytujemy RAZ, a potem
   klonujemy go dla każdego motocykla — każdy klon dostaje własny szkielet
   i własną teksturę kevlaru w barwach klubu.

   Pozowanie korzysta z tych samych punktów, które gra liczyła dotąd dla
   zawodnika z walców: biodra na siodle, kierunek tułowia, manetki
   (obracające się razem z kierownicą) i podnóżki. Dzięki temu zachowanie
   w ślizgu, przechyle i przy upadku zostaje bez zmian.

   Wszystko liczone jest w przestrzeni ŚWIATA, bo kości mają w niej swoje
   macierze — cele podawane w układzie motocykla przeliczamy na świat.
   ===================================================================== */

const Zawodnik3D = {
  gotowy: false, blad: null, baza: null,

  wczytaj(sciezkaModelu, fakturaPNG, normalnaPNG) {
    return wczytajZawodnika(sciezkaModelu, fakturaPNG, normalnaPNG)
      .then(z => { this.baza = z; this.gotowy = true; return z; })
      .catch(e => { this.blad = e && e.message ? e.message : String(e); throw e; });
  },

  // Klon dla jednego motocykla. rodzic to grupa motocykla, więc zawodnik
  // jeździ razem z maszyną bez żadnego dodatkowego przeliczania.
  stworz(rodzic, opcje) {
    if (!this.gotowy || !THREE.SkeletonUtils) return null;
    const klon = THREE.SkeletonUtils.clone(this.baza.scena);
    klon.scale.setScalar(this.baza.skala);
    let siatka = null;
    klon.traverse(o => { if (o.isSkinnedMesh) siatka = o; });
    if (!siatka) return null;
    siatka.frustumCulled = false;      // szkielet psuje wyliczoną kulę otaczającą
    siatka.material = new THREE.MeshStandardMaterial({
      map: this.baza.tekstura(opcje),
      normalMap: this.baza.mapaNorm,
      normalScale: new THREE.Vector2(0.85, 0.85),
      roughness: 0.74, metalness: 0.0, skinning: true
    });
    rodzic.add(klon);
    const K = {};
    siatka.skeleton.bones.forEach(b => K[bezPrzedrostka(b.name)] = b);
    const z = { klon, siatka, K, spoczynek: null };
    // Palce zaciskamy RAZ, przy budowie. W biegu nie zmieniają układu, a
    // liczenie ich sześćdziesiąt razy na klatkę byłoby marnotrawstwem.
    rodzic.updateMatrixWorld(true);
    zacisnij(z, 'Left'); zacisnij(z, 'Right');
    z.spoczynek = siatka.skeleton.bones.map(b => b.quaternion.clone());
    return z;
  },

  usun(rodzic, z) {
    if (!z) return;
    rodzic.remove(z.klon);
    if (z.siatka.material.map) z.siatka.material.map.dispose();
    z.siatka.material.dispose();
  },

  pozuj(z, rodzic, d) { pozujModel(z, rodzic, d); }
};

/* ---------- narzędzia obrotu w przestrzeni świata ---------- */
const _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3(), _v5 = new THREE.Vector3();

function obrocWSwiecie(kosc, os, kat) {
  if (!kosc || !kosc.parent) return;
  const qP = kosc.parent.getWorldQuaternion(_q1).invert();
  const qW = kosc.getWorldQuaternion(_q2);
  kosc.quaternion.copy(qP.multiply(_q3.setFromAxisAngle(os, kat)).multiply(qW));
  kosc.updateWorldMatrix(false, true);
}

// Kości Mixamo mają oś wzdłuż lokalnego +Y — kierujemy ją na zadany punkt.
function celujKosc(kosc, cel) {
  if (!kosc || !kosc.parent) return;
  kosc.updateWorldMatrix(true, false);
  const poz = _v1.setFromMatrixPosition(kosc.matrixWorld);
  const kier = _v2.copy(cel).sub(poz);
  if (kier.lengthSq() < 1e-10) return;
  kier.normalize();
  const qW = kosc.getWorldQuaternion(_q1).clone();
  const os = _v3.set(0, 1, 0).applyQuaternion(qW).normalize();
  const nowy = _q2.setFromUnitVectors(os, kier).multiply(qW);
  const qP = kosc.parent.getWorldQuaternion(_q3).invert();
  kosc.quaternion.copy(qP.multiply(nowy));
  kosc.updateWorldMatrix(false, true);
}

function ikDwie(gorna, dolna, koniec, cel, biegun) {
  if (!gorna || !dolna || !koniec) return;
  gorna.updateWorldMatrix(true, false);
  dolna.updateWorldMatrix(true, false);
  koniec.updateWorldMatrix(true, false);
  const A = _v1.setFromMatrixPosition(gorna.matrixWorld).clone();
  const B = _v2.setFromMatrixPosition(dolna.matrixWorld);
  const C = _v3.setFromMatrixPosition(koniec.matrixWorld);
  const l1 = A.distanceTo(B), l2 = B.distanceTo(C);
  const kier = _v4.subVectors(cel, A);
  const d = Math.min(kier.length(), (l1 + l2) * 0.995);
  if (d < 1e-6) return;
  kier.normalize();
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  const bg = _v5.subVectors(biegun, A);
  bg.addScaledVector(kier, -bg.dot(kier));
  if (bg.lengthSq() < 1e-10) bg.set(0, 0, 1); else bg.normalize();
  const staw = A.clone().addScaledVector(kier, a).addScaledVector(bg, h);
  celujKosc(gorna, staw);
  celujKosc(dolna, cel);
}

// Obrót dłoni wokół własnej osi: przy chwycie linia kostek biegnie wzdłuż rury.
function obrocDlon(z, strona, osRury) {
  const dlon = z.K[strona + 'Hand'], wsk = z.K[strona + 'HandIndex1'], maly = z.K[strona + 'HandPinky1'];
  if (!dlon || !wsk || !maly) return;
  dlon.updateWorldMatrix(true, false); wsk.updateWorldMatrix(true, false); maly.updateWorldMatrix(true, false);
  const osD = _v1.set(0, 1, 0).applyQuaternion(dlon.getWorldQuaternion(_q1)).normalize().clone();
  const kostki = _v2.setFromMatrixPosition(wsk.matrixWorld).sub(_v3.setFromMatrixPosition(maly.matrixWorld));
  kostki.addScaledVector(osD, -kostki.dot(osD));
  if (kostki.lengthSq() < 1e-10) return;
  kostki.normalize();
  const cel = _v4.copy(osRury);
  cel.addScaledVector(osD, -cel.dot(osD));
  if (cel.lengthSq() < 1e-10) return;
  cel.normalize();
  const kat = Math.atan2(_v5.crossVectors(kostki, cel).dot(osD), kostki.dot(cel));
  obrocWSwiecie(dlon, osD, kat);
}

/* Zaciśnięcie palców. Osie lokalne kości palców są nieznane, więc sprawdzamy
   oba znaki obrotu i zostawiamy ten, który zbliża opuszkę do nadgarstka. */
function zacisnij(z, strona) {
  const K = z.K;
  const dlon = K[strona + 'Hand'], wsk = K[strona + 'HandIndex1'], maly = K[strona + 'HandPinky1'];
  if (!dlon || !wsk || !maly) return;
  dlon.updateWorldMatrix(true, false); wsk.updateWorldMatrix(true, false); maly.updateWorldMatrix(true, false);
  const nadgarstek = new THREE.Vector3().setFromMatrixPosition(dlon.matrixWorld);
  const os = new THREE.Vector3().setFromMatrixPosition(wsk.matrixWorld)
    .sub(new THREE.Vector3().setFromMatrixPosition(maly.matrixWorld)).normalize();
  for (const p of ['Index', 'Middle', 'Ring', 'Pinky', 'Thumb']) {
    const czlony = [1, 2, 3].map(i => K[strona + 'Hand' + p + i]).filter(Boolean);
    const koniec = K[strona + 'Hand' + p + '4'] || czlony[czlony.length - 1];
    if (!czlony.length || !koniec) continue;
    const kat = p === 'Thumb' ? 0.60 : 1.10;
    koniec.updateWorldMatrix(true, false);
    const przed = new THREE.Vector3().setFromMatrixPosition(koniec.matrixWorld).distanceTo(nadgarstek);
    czlony.forEach(k => obrocWSwiecie(k, os, kat));
    koniec.updateWorldMatrix(true, false);
    const po = new THREE.Vector3().setFromMatrixPosition(koniec.matrixWorld).distanceTo(nadgarstek);
    if (po > przed) czlony.forEach(k => obrocWSwiecie(k, os, -2 * kat));
  }
}

/* ---------- pozowanie na podstawie punktów liczonych przez grę ---------- */
const _cel1 = new THREE.Vector3(), _cel2 = new THREE.Vector3();

function pozujModel(z, rodzic, d) {
  const K = z.K, bones = z.siatka.skeleton.bones;
  for (let i = 0; i < bones.length; i++) bones[i].quaternion.copy(z.spoczynek[i]);

  // biodra na siodle — przesuwamy cały klon, bo obrót kręgosłupa ich nie rusza
  z.klon.position.set(0, 0, 0);
  rodzic.updateMatrixWorld(true);
  const bioW = _cel1.setFromMatrixPosition(K.Hips.matrixWorld);
  const bioL = rodzic.worldToLocal(bioW.clone());
  z.klon.position.set(d.bx - bioL.x, d.by - bioL.y, d.bz - bioL.z);
  rodzic.updateMatrixWorld(true);

  const qM = rodzic.getWorldQuaternion(_q1).clone();
  const doSwiata = (x, y, z2) => rodzic.localToWorld(new THREE.Vector3(x, y, z2));

  // tułów: obracamy kręgosłup z pionu na kierunek liczony przez grę
  const spoczW = new THREE.Vector3(0, 1, 0).applyQuaternion(qM).normalize();
  const celW = new THREE.Vector3(d.ux, d.uy, d.uz).applyQuaternion(qM).normalize();
  const os = new THREE.Vector3().crossVectors(spoczW, celW);
  if (os.lengthSq() > 1e-10) {
    os.normalize();
    const kat = Math.acos(Math.max(-1, Math.min(1, spoczW.dot(celW))));
    obrocWSwiecie(K.Spine, os, kat * 0.40);
    obrocWSwiecie(K.Spine1, os, kat * 0.34);
    obrocWSwiecie(K.Spine2, os, kat * 0.26);
  }
  // głowa uniesiona i skręcona w łuk
  const osBok = new THREE.Vector3(1, 0, 0).applyQuaternion(qM).normalize();
  obrocWSwiecie(K.Neck, osBok, -0.42);
  obrocWSwiecie(K.Head, osBok, -0.30);
  if (d.patrz) obrocWSwiecie(K.Head, new THREE.Vector3(0, 1, 0).applyQuaternion(qM), d.patrz);

  // barki lekko do przodu — dokładają zasięgu obu ramionom
  const osPion = new THREE.Vector3(0, 1, 0).applyQuaternion(qM);
  obrocWSwiecie(K.LeftShoulder, osPion, -0.20);
  obrocWSwiecie(K.RightShoulder, osPion, 0.20);

  const biodraW = _cel2.setFromMatrixPosition(K.Hips.matrixWorld).clone();
  const bLokL = doSwiata(d.bx + 0.70, d.by + 0.60, d.bz - 0.45);
  const bLokP = doSwiata(d.bx - 0.70, d.by + 0.60, d.bz - 0.45);
  const bKolL = doSwiata(d.bx + 0.55, d.by + 0.35, d.bz + 1.40);
  const bKolP = doSwiata(d.bx - 0.55, d.by + 0.35, d.bz + 1.40);
  void biodraW;

  const chwytL = doSwiata(d.glx, d.gly, d.glz);
  const chwytP = doSwiata(d.gpx, d.gpy, d.gpz);
  ikDwie(K.LeftArm, K.LeftForeArm, K.LeftHand, chwytL, bLokL);
  ikDwie(K.RightArm, K.RightForeArm, K.RightHand, chwytP, bLokP);
  ikDwie(K.LeftUpLeg, K.LeftLeg, K.LeftFoot, doSwiata(d.slx, d.sly, d.slz), bKolL);
  ikDwie(K.RightUpLeg, K.RightLeg, K.RightFoot, doSwiata(d.spx, d.spy, d.spz), bKolP);

  // rura kierownicy obraca się razem ze skrętem, więc i dłonie za nią idą
  const osRury = new THREE.Vector3(Math.cos(d.steer), 0, -Math.sin(d.steer)).applyQuaternion(qM).normalize();
  obrocDlon(z, 'Left', osRury);
  obrocDlon(z, 'Right', osRury);
}
