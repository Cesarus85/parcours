import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import { ARButton } from 'https://unpkg.com/three@0.160.0/examples/jsm/webxr/ARButton.js';

/** ========= DOM ========= */
const canvas = document.getElementById('c');
const btnStart = document.getElementById('btnStart');
const btnPlace = document.getElementById('btnPlace');
const btnRecenter = document.getElementById('btnRecenter');
const btnReset = document.getElementById('btnReset');
const metricsEl = document.getElementById('metrics');
const scoreEl = document.getElementById('score');
const comboEl = document.getElementById('combo');
const missesEl = document.getElementById('misses');

/** ========= Three.js base ========= */
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.xr.enabled = true;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 50);
const light = new THREE.HemisphereLight(0xffffff, 0x444444, 0.9);
scene.add(light);

/** ========= Reticle ========= */
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.15, 0.17, 32),
  new THREE.MeshBasicMaterial({ color: 0x44ff88, transparent: true, opacity: 0.9, side: THREE.DoubleSide })
);
reticle.rotation.x = -Math.PI / 2;
reticle.visible = false;
scene.add(reticle);

/** ========= Track (Treadmill only) =========
 *  Breite 1.8 m (innerhalb 1.5–2.0 m), Länge 3.0 m
 */
const track = {
  width: 1.8,
  length: 3.0,
  treadmill: true,
  speed: 1.5,         // m/s – Bewegung der Hindernisse Richtung Spieler
  laneOffset: 0.6,    // drei "gedachte" Lanes: -0.6, 0, +0.6
};
let trackRoot = null;

function makeTrackRoot(width, length) {
  const root = new THREE.Group();

  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, length),
    new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.08 })
  );
  plane.rotation.x = -Math.PI / 2;
  plane.position.z = -length / 2;
  root.add(plane);

  const grid = new THREE.GridHelper(length, Math.max(2, Math.round(length * 2)), 0x66ccff, 0x224455);
  grid.rotation.y = Math.PI / 2;
  grid.position.z = -length / 2;
  root.add(grid);

  const left = lineY(0x66ccff, -width / 2, -length, 0);
  const right = lineY(0x66ccff, +width / 2, -length, 0);
  root.add(left, right);

  return root;
}
function lineY(color, x, z1, z2) {
  const g = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(x, 0.001, z1),
    new THREE.Vector3(x, 0.001, z2)
  ]);
  const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
  return new THREE.Line(g, m);
}

/** ========= XR state ========= */
let xrSession = null;
let referenceSpace = null;
let viewerSpace = null;
let hitTestSource = null;
let placing = false;

/** ========= Player metrics (head-based) ========= */
const player = {
  baselineY: null,
  smoothY: null,
  smoothVy: 0,
  lastY: null,
  lastT: null,
  lateralX: 0,
  headRadius: 0.18, // ~Kopf-Radius
  DUCK_DELTA: 0.25,
  JUMP_VY: 1.2,
  JUMP_MIN_DY: 0.10,
  LATERAL_STEP: 0.35,
  lastJumpAt: 0,
};

/** ========= Scoring ========= */
const game = {
  score: 0,
  combo: 0,
  misses: 0,
  running: true,
};
function addScore(pts) {
  game.score += pts;
  game.combo++;
  scoreEl.textContent = game.score.toString();
  comboEl.textContent = 'x' + game.combo;
}
function addMiss() {
  game.misses++;
  game.combo = 0;
  missesEl.textContent = game.misses.toString();
  comboEl.textContent = 'x0';
  // kleiner UI-Flash
  document.querySelector('.hud').classList.remove('flash');
  void document.querySelector('.hud').offsetWidth;
  document.querySelector('.hud').classList.add('flash');
}
function resetGameStats() {
  game.score = 0; game.combo = 0; game.misses = 0;
  scoreEl.textContent = '0'; comboEl.textContent = 'x0'; missesEl.textContent = '0';
}

/** ========= Obstacle System (Treadmill) =========
 * Typen:
 *  - OVERHEAD_BAR: ducken; echte Kopf-Kollision via Sphere-AABB
 *  - GATE_LEFT / GATE_RIGHT: Seitenwände lassen nur eine Lane frei; Kollision via Sphere-AABB
 *  - HURDLE (optional): erfordert Jump-Event in Zeitfenster; kein Kopf-Collide
 */
const OBST = {
  OVERHEAD_BAR: 'overhead',
  GATE_LEFT: 'gate_left',
  GATE_RIGHT: 'gate_right',
  HURDLE: 'hurdle',
};

class Obstacle {
  constructor(type) {
    this.type = type;
    this.group = new THREE.Group();
    this.active = false;
    this.speed = track.speed;

    // bounding box relativer Halbgrößen (AABB) in Track-Local
    this.hx = 0.5; this.hy = 0.5; this.hz = 0.2;

    // Visual + Maße je Typ
    let mesh = null;
    if (type === OBST.OVERHEAD_BAR) {
      const thickness = 0.15;
      const height = 1.35; // Unterkante ~1.35m → Ducken
      const barGeom = new THREE.BoxGeometry(track.width, thickness, 0.25);
      const mat = new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.9 });
      mesh = new THREE.Mesh(barGeom, mat);
      mesh.position.set(0, height, 0);
      this.group.add(mesh);

      this.hx = track.width * 0.5;
      this.hy = thickness * 0.5;
      this.hz = 0.125;
    }
    else if (type === OBST.GATE_LEFT || type === OBST.GATE_RIGHT) {
      // Zwei Paneele; eine Seite bleibt offen
      const wallW = track.width * 0.33; // blockt zwei Lanes → eine bleibt frei
      const wallH = 2.0;
      const wallZ = 0.25;
      const mat = new THREE.MeshBasicMaterial({ color: 0x0099ff, transparent: true, opacity: 0.6 });
      const g = new THREE.BoxGeometry(wallW, wallH, wallZ);

      const left = new THREE.Mesh(g, mat);
      const right = new THREE.Mesh(g, mat);
      const gapSide = (type === OBST.GATE_LEFT) ? -1 : +1; // offene Seite
      const blockSide = -gapSide;

      left.position.set(blockSide * (track.width / 2 - wallW / 2), wallH / 2, 0);
      right.position.set(gapSide * (track.width * 0.5 + 10), wallH / 2, 0); // weit draußen, „unsichtbar“
      this.group.add(left, right);

      // AABB nur für blockierende Wand (rechteck)
      this._aabbOffsetX = left.position.x;
      this.hx = wallW / 2;
      this.hy = wallH / 2;
      this.hz = wallZ / 2;
    }
    else if (type === OBST.HURDLE) {
      // Niedrige Hürde (~0.45m hoch) – Erfolg via Jump-Fenster, kein Kopf-Collide
      const h = 0.45, w = track.width * 0.6, d = 0.2;
      const geom = new THREE.BoxGeometry(w, h, d);
      const mat = new THREE.MeshBasicMaterial({ color: 0x66ff66, transparent: true, opacity: 0.85 });
      mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(0, h / 2, 0);
      this.group.add(mesh);

      this.hx = w / 2; this.hy = h / 2; this.hz = d / 2;
      this.requiresJump = true;
      this._cleared = false;
    }

    this.typeMesh = mesh;
  }

  spawn(zStart) {
    this.active = true;
    this.group.visible = true;
    this.group.position.set(0, 0, zStart); // Track-Local
    this._cleared = false;
  }

  update(dt) {
    if (!this.active) return;
    this.group.position.z += this.speed * dt; // Richtung Spieler (z -> 0)
  }

  // AABB in Track-Local (mit ggf. Offset bei Gate)
  getAABB() {
    const { x, y, z } = this.group.position;
    let cx = x;
    if (this.type === OBST.GATE_LEFT || this.type === OBST.GATE_RIGHT) {
      // nur blockierende Paneel-AABB (am Offset)
      cx = x + this._aabbOffsetX;
    }
    return {
      min: new THREE.Vector3(cx - this.hx, (y + this.hy) - this.hy * 2, z - this.hz),
      max: new THREE.Vector3(cx + this.hx, (y + this.hy), z + this.hz),
    };
  }

  // HURDLE: Prüfe Zeitfenster rund um z≈0 auf Jump
  checkHurdleClear(nowSec) {
    if (!this.requiresJump || this._cleared) return false;
    const z = this.group.position.z;
    if (z > -0.2 && z < 0.3) { // Durchlauf-Zeitfenster nahe Spieler
      // Jump musste in den letzten 350ms stattgefunden haben
      if (nowSec - player.lastJumpAt < 0.35) {
        this._cleared = true;
        return true;
      } else {
        // wenn Fenster passiert und kein Jump: zählt als Treffer (Miss) – abfangen im Collide-Check
        // hier noch nicht „missen“, das passiert unten im Main-Loop
        return false;
      }
    }
    return null; // noch nicht in Fenster
  }

  recycle() {
    this.active = false;
    this.group.visible = false;
  }
}

// Pool
const pool = {
  all: [],
  active: [],
  get(type) {
    let o = this.all.find(x => !x.active && x.type === type);
    if (!o) {
      o = new Obstacle(type);
      trackRoot?.add(o.group);
      this.all.push(o);
    }
    // ensure attached after placement
    if (trackRoot && o.group.parent !== trackRoot) trackRoot.add(o.group);
    this.active.push(o);
    return o;
  },
  update(dt) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ob = this.active[i];
      ob.update(dt);
      if (ob.group.position.z > 0.6) { // hinter dem Spieler → recyceln
        ob.recycle();
        this.active.splice(i, 1);
      }
    }
  },
  clear() {
    this.active.forEach(o => o.recycle());
    this.active.length = 0;
  }
};

// Spawner
const spawner = {
  t: 0,
  nextIn: 1.1,
  minGap: 0.8, // min Abstand (s)
  spawn() {
    if (!trackRoot) return;
    // gewichtete Auswahl: Overhead, Gate, Hurdle
    const r = Math.random();
    let type = OBST.OVERHEAD_BAR;
    if (r < 0.4) type = OBST.OVERHEAD_BAR;
    else if (r < 0.75) type = (Math.random() < 0.5) ? OBST.GATE_LEFT : OBST.GATE_RIGHT;
    else type = OBST.HURDLE;

    const o = pool.get(type);
    const zStart = -track.length - 0.5; // etwas vor Bahnstart, damit „aus Distanz“ sichtbar
    o.spawn(zStart);

    // Seitliche Variation (nicht für Gate, Overhead überspannt Breite)
    if (type === OBST.HURDLE) {
      const lane = [-track.laneOffset, 0, track.laneOffset][(Math.random()*3|0)];
      o.group.position.x = lane;
    }

    // nächstes Spawnintervall: leicht zufällig, skaliert mit speed
    const base = THREE.MathUtils.mapLinear(track.speed, 1.0, 2.5, 1.4, 0.9);
    spawner.nextIn = THREE.MathUtils.clamp(base + (Math.random()*0.6 - 0.3), 0.75, 1.8);
  },
  update(dt) {
    this.t += dt;
    if (this.t >= this.nextIn) {
      this.t = 0;
      this.spawn();
    }
  },
  reset() { this.t = 0; this.nextIn = 1.1; },
};

/** ========= Utilities ========= */
function setMetricsText(h, vy, x) {
  metricsEl.textContent = `H: ${h.toFixed(2)} m | vY: ${vy.toFixed(2)} m/s | X: ${x.toFixed(2)} m`;
}
function lowpass(prev, next, a) { return prev == null ? next : THREE.MathUtils.lerp(prev, next, a); }
function clamp(x, a, b) { return Math.min(Math.max(x, a), b); }
function sphereIntersectsAABB(c, r, min, max) {
  const cx = clamp(c.x, min.x, max.x);
  const cy = clamp(c.y, min.y, max.y);
  const cz = clamp(c.z, min.z, max.z);
  const dx = c.x - cx, dy = c.y - cy, dz = c.z - cz;
  return (dx*dx + dy*dy + dz*dz) <= (r*r);
}

/** ========= UI Events ========= */
btnPlace.addEventListener('click', () => placing = !placing);
btnRecenter.addEventListener('click', () => {
  if (trackRoot) {
    const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    trackRoot.position.copy(pos);
    trackRoot.rotation.set(0, yaw, 0);
  }
});
btnReset.addEventListener('click', () => {
  resetGameStats();
  pool.clear();
  spawner.reset();
});

/** ========= Start AR ========= */
btnStart.addEventListener('click', async () => {
  if (xrSession) return;
  try {
    xrSession = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['local-floor', 'anchors', 'dom-overlay'],
      domOverlay: { root: document.body }
    });
  } catch {
    xrSession = await navigator.xr.requestSession('immersive-ar', { requiredFeatures: ['hit-test'] });
  }

  renderer.xr.setReferenceSpaceType('local-floor');
  renderer.xr.setSession(xrSession);

  referenceSpace = await xrSession.requestReferenceSpace('local-floor').catch(() => xrSession.requestReferenceSpace('local'));
  viewerSpace = await xrSession.requestReferenceSpace('viewer');
  hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });

  placing = true;

  xrSession.addEventListener('end', () => {
    hitTestSource = null; xrSession = null; referenceSpace = null;
    reticle.visible = false; if (trackRoot) trackRoot.visible = true;
  });

  xrSession.addEventListener('select', onSelectPlace);

  renderer.setAnimationLoop(onXRFrame);
});

function onSelectPlace() {
  if (!placing || !reticle.visible) return;
  placeTrackAtReticle();
  // Reset Kalibrierung + Spiel
  player.baselineY = null; player.smoothY = null; player.smoothVy = 0; player.lastY = null; player.lastT = null;
  resetGameStats(); pool.clear(); spawner.reset();
  console.log('[Place] Track gesetzt. Kalibriere Kopf-Baseline in den nächsten 2 Sekunden.');
}

function placeTrackAtReticle() {
  if (!trackRoot) {
    trackRoot = makeTrackRoot(track.width, track.length);
    scene.add(trackRoot);
  }
  trackRoot.position.copy(reticle.position);
  // Ausrichtung: Yaw = Blickrichtung
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
  const yaw = Math.atan2(forward.x, forward.z);
  trackRoot.rotation.set(0, yaw, 0);
  trackRoot.position.y = 0; // Boden
  // Hänge ggf. bestehende Poolobjekte an trackRoot (falls zuvor erzeugt)
  pool.all.forEach(o => { if (o.group.parent !== trackRoot) trackRoot.add(o.group); });
}

/** ========= XR Frame Loop ========= */
function onXRFrame(t, frame) {
  const pose = frame.getViewerPose(referenceSpace);
  if (!pose) return;

  // --- HitTest & Reticle ---
  if (hitTestSource && placing) {
    const results = frame.getHitTestResults(hitTestSource);
    if (results.length) {
      const hit = results[0];
      const hitPose = hit.getPose(referenceSpace);
      reticle.visible = true;
      reticle.position.set(hitPose.transform.position.x, 0.0, hitPose.transform.position.z);
      // Yaw in Blickrichtung
      const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).setY(0).normalize();
      const yaw = Math.atan2(forward.x, forward.z);
      reticle.rotation.set(-Math.PI / 2, yaw, 0);
    } else {
      reticle.visible = false;
    }
  } else {
    reticle.visible = false;
  }

  // --- Player Metrics ---
  const now = t * 0.001;
  const head = pose.views[0].transform.position;
  const y = head.y;

  if (player.lastT != null) {
    const dt = Math.max(0.001, now - player.lastT);
    const vy = (y - player.lastY) / dt;
    player.smoothY = lowpass(player.smoothY, y, 0.25);
    player.smoothVy = lowpass(player.smoothVy, vy, 0.2);
  }
  player.lastY = y; player.lastT = now;

  // Kalibrierung (erste ~2s)
  if (player.baselineY == null) {
    if (!player._acc) { player._acc = { sum: 0, n: 0, t0: now }; }
    player._acc.sum += y; player._acc.n++;
    if (now - player._acc.t0 > 2.0 && player._acc.n > 20) {
      player.baselineY = player._acc.sum / player._acc.n;
      player._acc = null;
      console.log(`[Calib] baselineY ≈ ${player.baselineY.toFixed(3)} m`);
    }
  }

  // Seitversatz relativ zu Track
  if (trackRoot) {
    const headWorld = new THREE.Vector3(head.x, head.y, head.z);
    const headLocal = trackRoot.worldToLocal(headWorld.clone());
    player.lateralX = headLocal.x;
  } else {
    player.lateralX = 0;
  }

  // --- Gesten-Events ---
  if (player.baselineY != null && player.smoothY != null) {
    const dy = player.smoothY - player.baselineY;

    // Duck
    if (dy < -player.DUCK_DELTA) {
      if (!player._duckOn) { player._duckOn = true; /* optional: Feedback */ }
    } else { player._duckOn = false; }

    // Jump
    if (player.smoothVy > player.JUMP_VY && dy > player.JUMP_MIN_DY) {
      if (!player._lastJump || (now - player._lastJump) > 0.35) {
        player._lastJump = now;
        player.lastJumpAt = now;
        // console.log('JUMP');
      }
    }

    setMetricsText(player.smoothY, player.smoothVy, player.lateralX);
  } else {
    setMetricsText(y, 0, player.lateralX);
  }

  // --- Game Update (nur wenn platziert) ---
  if (trackRoot) {
    const dt = renderer.xr.getFrame().deltaTime ? renderer.xr.getFrame().deltaTime / 1000 : 1/60;

    // Spawner + Bewegung
    spawner.update(dt);
    pool.update(dt);

    // Kollision / Erfolg
    // Kopfposition in Track-Local:
    const headLocal = trackRoot.worldToLocal(new THREE.Vector3(head.x, head.y, head.z));
    const headR = player.headRadius;

    for (let i = pool.active.length - 1; i >= 0; i--) {
      const ob = pool.active[i];

      // HURDLE: Event-Fenster prüfen
      if (ob.type === OBST.HURDLE) {
        const cleared = ob.checkHurdleClear(now);
        if (cleared === true) {
          addScore(2);
        } else if (cleared === false && ob.group.position.z > 0.3) {
          // Fenster verpasst → Miss
          addMiss();
        }
      }

      // AABB-Kollision (Overhead & Gate)
      if (ob.type !== OBST.HURDLE) {
        const aabb = ob.getAABB();
        if (sphereIntersectsAABB(headLocal, headR, aabb.min, aabb.max)) {
          addMiss();
          // visuelles Feedback am Hindernis
          if (ob.typeMesh) {
            ob.typeMesh.material.color.setHex(0xff3344);
            ob.typeMesh.material.opacity = 0.95;
          }
        } else {
          // Wenn Spieler die AABB-Scheibe „sauber“ passiert hat, und z hinter 0.3 → Score
          if (ob.group.position.z > 0.3 && !ob._scored) {
            ob._scored = true;
            addScore(1);
          }
        }
      }

      // Recycle, wenn weit hinter Spieler
      if (ob.group.position.z > 0.6) {
        ob.recycle();
        pool.active.splice(i, 1);
      }
    }
  }

  renderer.render(scene, camera);
}

/** ========= Resize ========= */
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
