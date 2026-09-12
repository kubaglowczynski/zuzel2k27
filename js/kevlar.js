/* =====================================================================
   KEVLAR PROCEDURALNY

   Model z Mixamo ma jeden atlas na całą postać. Żeby pomalować go w barwy
   klubu, trzeba wiedzieć, który fragment atlasu odpowiada której części
   ciała. Nie zgadujemy tego — liczymy z wag skórowania: dla każdego
   wierzchołka sprawdzamy, która kość ma największą wagę, i z tego wynika
   przynależność do partii ciała. Potem rasteryzujemy trójkąty w
   przestrzeni tekstury i dostajemy mapę etykiet.

   Barwy nie są płaskie. Jasność oryginalnej tekstury (plik faktura.png)
   służy jako faktura — zostają zmarszczki, szwy, splot, zamki i podeszwy,
   a zmienia się tylko odcień. To ta sama sztuczka, którą stosuje się w
   grach sportowych do wariantów strojów.

   Mapa etykiet zależy wyłącznie od siatki, więc liczymy ją RAZ i wszyscy
   zawodnicy korzystają z tej samej. Zmiana barw to już tylko przemalowanie.
   ===================================================================== */

const CZESCI = ['tulow', 'biodra', 'ramie', 'przedramie', 'bark',
                'dlon', 'udo', 'lydka', 'but', 'kask', 'szyja'];

// Prostokąt pleców w przestrzeni tekstury. Wyznaczony pomiarowo: to
// największa spójna wyspa trójkątów tułowia o normalnej skierowanej do tyłu.
const PLECY = { u0: 0.017, v0: 0.040, u1: 0.257, v1: 0.331 };

// three.js oczyszcza nazwy węzłów przy wczytywaniu glTF i USUWA DWUKROPEK,
// więc "mixamorig6:Hips_01" staje się "mixamorig6Hips_01". Wycinanie przedrostka
// wraz z dwukropkiem nie trafiało w nic i wszystkie kości lądowały poza podziałem.
function bezPrzedrostka(nazwa) {
  return String(nazwa).replace(/^.*?mixamorig\d*:?/i, '').replace(/_\d+$/, '');
}
function czescCiala(nazwaKosci) {
  const n = bezPrzedrostka(nazwaKosci);
  if (/^(Left|Right)Hand/.test(n)) return 'dlon';
  if (/^(Left|Right)ForeArm$/.test(n)) return 'przedramie';
  if (/^(Left|Right)Arm$/.test(n)) return 'ramie';
  if (/^(Left|Right)Shoulder$/.test(n)) return 'bark';
  if (n === 'Hips') return 'biodra';
  if (/^Spine/.test(n)) return 'tulow';
  if (/^Neck/.test(n)) return 'szyja';     // kominiarka i kołnierz, nie kask
  if (/^Head/.test(n)) return 'kask';
  if (/^(Left|Right)UpLeg$/.test(n)) return 'udo';
  if (/^(Left|Right)Leg$/.test(n)) return 'lydka';
  if (/^(Left|Right)(Foot|ToeBase)/.test(n)) return 'but';
  return 'inne';
}

/* Mapa etykiet: dla każdego piksela atlasu zapisuje numer partii ciała.
   Trójkąte grupujemy po partiach i rysujemy jedną ścieżką na partię —
   50 tysięcy osobnych wywołań rysowania trwałoby sekundy, dziesięć trwa
   kilkadziesiąt milisekund. */
/* Mapa partii ciała i wysokości na sylwetce.

   Rasteryzujemy trójkąty własną pętlą zamiast rysowaniem po kanwie. Kanwa
   wygładza krawędzie, przez co etykiety sąsiadów mieszały się w wartość
   pośrednią, a wysokość dało się zapisać tylko skokowo — stąd piłokształtne
   brzegi pasów. Własny rasteryzator daje ostre etykiety i PŁYNNIE
   interpolowaną wysokość, więc pas biegnie gładko dookoła ciała. */
function mapaCzesci(siatka, R) {
  const geo = siatka.geometry;
  const poz = geo.attributes.position;
  const uv = geo.attributes.uv;
  const skinIdx = geo.attributes.skinIndex;
  const wagi = geo.attributes.skinWeight;
  const idx = geo.index;
  const kosci = siatka.skeleton.bones;
  const skl = (a, i, k) => k === 0 ? a.getX(i) : k === 1 ? a.getY(i) : k === 2 ? a.getZ(i) : a.getW(i);

  const etyk = new Uint8Array(poz.count);
  let yMin = Infinity, yMax = -Infinity;
  for (let i = 0; i < poz.count; i++) {
    let naj = 0, najW = -1;
    for (let k = 0; k < 4; k++) {
      const w = skl(wagi, i, k);
      if (w > najW) { najW = w; naj = skl(skinIdx, i, k); }
    }
    etyk[i] = CZESCI.indexOf(czescCiala(kosci[naj] ? kosci[naj].name : '')) + 1;
    const y = poz.getY(i); if (y < yMin) yMin = y; if (y > yMax) yMax = y;
  }
  const rozY = Math.max(1e-6, yMax - yMin);

  const mapa = new Uint8Array(R * R);
  const wys = new Uint8Array(R * R);
  const n = idx ? idx.count : poz.count;

  for (let t = 0; t < n; t += 3) {
    const i0 = idx ? idx.getX(t) : t, i1 = idx ? idx.getX(t + 1) : t + 1, i2 = idx ? idx.getX(t + 2) : t + 2;
    const e = etyk[i0]; if (!e) continue;
    const ax = uv.getX(i0) * R, ay = uv.getY(i0) * R;
    const bx = uv.getX(i1) * R, by = uv.getY(i1) * R;
    const cx = uv.getX(i2) * R, cy = uv.getY(i2) * R;
    const pole = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(pole) < 1e-9) continue;
    const h0 = (poz.getY(i0) - yMin) / rozY, h1 = (poz.getY(i1) - yMin) / rozY, h2 = (poz.getY(i2) - yMin) / rozY;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx)) - 1);
    const x1 = Math.min(R - 1, Math.ceil(Math.max(ax, bx, cx)) + 1);
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy)) - 1);
    const y1 = Math.min(R - 1, Math.ceil(Math.max(ay, by, cy)) + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5, py = y + 0.5;
        let u = ((bx - px) * (cy - py) - (cx - px) * (by - py)) / pole;
        let v = ((cx - px) * (ay - py) - (ax - px) * (cy - py)) / pole;
        let w = 1 - u - v;
        if (u < -0.06 || v < -0.06 || w < -0.06) continue;   // zapas na szwy
        u = u < 0 ? 0 : u; v = v < 0 ? 0 : v; w = w < 0 ? 0 : w;
        const k = y * R + x;
        mapa[k] = e;
        wys[k] = Math.round((h0 * u + h1 * v + h2 * w) / (u + v + w) * 255);
      }
    }
  }
  let pokryte = 0;
  for (let i = 0; i < R * R; i++) if (mapa[i]) pokryte++;
  mapa.pokrycie = pokryte / (R * R);
  mapa.wysokosc = wys;
  return mapa;
}

/* Malowanie kombinezonu. Zwraca gotową teksturę dla jednego zawodnika. */
function malujKevlar(mapa, faktura, R, opcje) {
  const { barwa1, barwa2, nazwisko, numer, kask: kaskB } = opcje;
  const hx = h => [1, 3, 5].map(i => parseInt(String(h).substr(i, 2), 16));
  const PRIM = hx(barwa1), AKC = hx(barwa2);
  const BARWY = {
    tulow: PRIM, bark: PRIM, ramie: PRIM, biodra: PRIM, udo: PRIM,
    przedramie: AKC,      // rękawy w barwie dodatkowej — czytelniejsze niż paski
    lydka: PRIM,          // mieszanka z barwą dodatkową dawała oliwkę
    dlon: [40, 36, 34],        // rękawice
    but: [24, 23, 26],         // buty
    kask: kaskB ? hx(kaskB) : [200, 60, 50],   // skorupa kasku
    szyja: [38, 36, 40]                        // kominiarka pod kaskiem
  };

  // średnia jasność w obrębie partii — względem niej liczymy fakturę
  const sumy = new Float64Array(CZESCI.length + 1), licz = new Float64Array(CZESCI.length + 1);
  for (let i = 0; i < R * R; i++) {
    const e = mapa[i];
    if (!e) continue;
    sumy[e] += faktura[i * 4]; licz[e]++;
  }

  const c = document.createElement('canvas');
  c.width = c.height = R;
  const x = c.getContext('2d');
  const out = x.createImageData(R, R), o = out.data;
  for (let i = 0; i < R * R; i++) {
    const e = mapa[i];
    const kol = e ? BARWY[CZESCI[e - 1]] : PRIM.map(v => v * 0.45);
    let det = 1;
    if (e && licz[e]) {
      const sr = sumy[e] / licz[e];
      // Zakres ściśnięty do 40% siły: zmarszczki i szwy zostają, ale jasne
      // panele oryginalnego stroju nie rozjaśniają już barwy klubowej do neonu.
      det = 1 + (faktura[i * 4] - sr) / Math.max(sr, 1) * 0.40;
      det = det < 0.74 ? 0.74 : det > 1.26 ? 1.26 : det;
    }
    o[i * 4] = Math.min(255, kol[0] * det);
    o[i * 4 + 1] = Math.min(255, kol[1] * det);
    o[i * 4 + 2] = Math.min(255, kol[2] * det);
    o[i * 4 + 3] = 255;
  }
  // Skorupa kasku tylko powyżej karku. Geometria kołnierza i kominiarki jest
  // przypisana do kości głowy, więc barwa kasku schodziła na kevlar. Wysokość
  // karku to 0,835 obrysu sylwetki — poniżej malujemy kominiarkę.
  const wysK = mapa.wysokosc;
  if (wysK) {
    const KASK_DOL = 0.838, MIEKKO = 0.012;
    const iKask = CZESCI.indexOf('kask') + 1;
    for (let i = 0; i < R * R; i++) {
      if (mapa[i] !== iKask) continue;
      const h = wysK[i] / 255;
      if (h >= KASK_DOL) continue;
      const t2 = Math.max(0, Math.min(1, (KASK_DOL - h) / MIEKKO));
      const kom = BARWY.szyja, sk = BARWY.kask;
      for (let c = 0; c < 3; c++)
        o[i * 4 + c] = o[i * 4 + c] * (1 - t2) + (kom[c] / Math.max(1, sk[c]) * o[i * 4 + c]) * t2;
    }
  }

  // Pasy w barwie dodatkowej. Zakresy podane jako ułamek wysokości sylwetki,
  // więc pas biegnie dookoła ciała.
  const wys = mapa.wysokosc;
  if (wys) {
    // Pas klatki i pas na udach. Brzegi zmiękczone, żeby nie było widać
    // przejścia piksel po pikselu.
    // Jeden gładki pas w talii. Pasy na udach wyglądały przypadkowo.
    const PASY = [[0.555, 0.600]];
    const suknia = { tulow: 1, bark: 1, biodra: 1, udo: 1 };
    const mieszaj = 0.006;
    const gladko = (kr, a, b) => {
      if (kr <= a || kr >= b) return 0;
      const t2 = Math.min((kr - a) / mieszaj, (b - kr) / mieszaj, 1);
      return t2 * t2 * (3 - 2 * t2);
    };
    for (let i = 0; i < R * R; i++) {
      const e = mapa[i];
      if (!e || !suknia[CZESCI[e - 1]]) continue;
      const h = wys[i];
      let u = 0;
      for (const [a, b] of PASY) { const v2 = gladko(h, a, b); if (v2 > u) u = v2; }
      if (u <= 0.002) continue;
      o[i * 4] = o[i * 4] * (1 - u) + Math.min(255, AKC[0] * (o[i * 4] / Math.max(1, PRIM[0]))) * u;
      o[i * 4 + 1] = o[i * 4 + 1] * (1 - u) + Math.min(255, AKC[1] * (o[i * 4 + 1] / Math.max(1, PRIM[1]))) * u;
      o[i * 4 + 2] = o[i * 4 + 2] * (1 - u) + Math.min(255, AKC[2] * (o[i * 4 + 2] / Math.max(1, PRIM[2]))) * u;
    }
  }
  x.putImageData(out, 0, 0);

  // nazwisko i numer na plecach
  const u0 = PLECY.u0 * R, v0 = PLECY.v0 * R;
  const sz = (PLECY.u1 - PLECY.u0) * R, wy = (PLECY.v1 - PLECY.v0) * R;
  const jasne = 0.2126 * PRIM[0] + 0.7152 * PRIM[1] + 0.0722 * PRIM[2] > 132;
  x.fillStyle = x.strokeStyle = jasne ? '#1a1e24' : '#f6f4ee';
  x.textAlign = 'center'; x.textBaseline = 'middle';
  const cx = u0 + sz / 2;
  // Wyspa pleców jest w atlasie odbita, więc napis rysowany wprost pokazywał
  // się na modelu lustrzanie. Odbijamy go w kanwie, żeby na siatce wyszedł prosto.
  x.save();
  x.translate(cx, 0); x.scale(-1, 1); x.translate(-cx, 0);
  x.font = `700 ${Math.round(wy * 0.115)}px "Barlow Condensed", Arial Narrow, Arial, sans-serif`;
  x.fillText(String(nazwisko).toUpperCase(), cx, v0 + wy * 0.26);
  const bw = sz * 0.50, bh = wy * 0.36, bx = cx - bw / 2, by = v0 + wy * 0.38;
  x.lineWidth = Math.max(3, sz * 0.016);
  x.beginPath();
  if (x.roundRect) x.roundRect(bx, by, bw, bh, sz * 0.045); else x.rect(bx, by, bw, bh);
  x.stroke();
  x.font = `700 ${Math.round(bh * 0.74)}px "Barlow Condensed", Arial Narrow, Arial, sans-serif`;
  x.fillText(String(numer), cx, by + bh / 2);
  x.restore();

  const t = new THREE.CanvasTexture(c);
  t.flipY = false;                 // glTF liczy współrzędne od góry obrazu
  t.encoding = THREE.sRGBEncoding;
  t.anisotropy = 8;
  return t;
}

/* Wczytanie modelu i przygotowanie fabryki zawodników. */
function wczytajZawodnika(sciezka, fakturaPNG, normalnaPNG) {
  return new Promise((ok, blad) => {
    const L = new THREE.GLTFLoader();
    const TL = new THREE.TextureLoader();
    let gltf = null, fakturaDane = null, mapaNorm = null;
    const gotowe = () => {
      if (!gltf || !fakturaDane || !mapaNorm) return;
      let siatka = null;
      gltf.scene.traverse(o => { if (o.isSkinnedMesh) siatka = o; });
      if (!siatka) return blad(new Error('brak siatki ze skórowaniem'));
      const R = 1024;
      const mapa = mapaCzesci(siatka, R);
      const probka = siatka.skeleton.bones.slice(0, 3).map(b => b.name + ' -> ' + czescCiala(b.name));
      ok({
        scena: gltf.scene, siatka, mapa, faktura: fakturaDane, R, mapaNorm, probka,
        // Skala: model jest w centymetrach, gra w metrach.
        skala: 0.01,
        tekstura(opcje) { return malujKevlar(mapa, fakturaDane, R, opcje); }
      });
    };
    L.load(sciezka, g => { gltf = g; gotowe(); }, undefined, blad);
    TL.load(fakturaPNG, t => {
      const c = document.createElement('canvas');
      c.width = c.height = 1024;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(t.image, 0, 0, 1024, 1024);
      fakturaDane = x.getImageData(0, 0, 1024, 1024).data;
      gotowe();
    }, undefined, blad);
    TL.load(normalnaPNG, t => {
      t.flipY = false; mapaNorm = t; gotowe();
    }, undefined, blad);
  });
}
