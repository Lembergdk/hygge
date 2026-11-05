// Interactive Hygge flame for the promo site.
//
// This is a port of the repo's drag model, not an approximation of it:
//   - Sources/HyggeCore/FlameTouchPhysics.swift — the touch spring
//   - App/Views/RiggedFlame.swift — layer anchors + lean + attachments
//   - App/Views/InteractiveFlame.swift + Sources/HyggeCore/FlamePlay.swift
//     — tap zones, reactions, long-press, double-tap, idle life, breath
//
// All physics runs in the repo's 210pt reference rig; pixels are just
// pt * (stageWidth / 210).
// This is a port of App/Views/FlameActor.swift (the app's home flame),
// not of the older InteractiveFlame wrapper: FlameTouchPhysics for the
// drag spring, FlamePose + FlameActor.run() for every reaction scene,
// FlameGestureClassifier for taps, and FlameIdlePlanner for idle life.
// What the web cannot do, and why, is called out below:
//   - Torso deformation is a Metal shader in the app (FlameStretch.metal).
//     Here each layer is translated by displacement(at:) at its anchor
//     point instead of being warped — same formula, rigid layers.
//   - Gyro lean and phone shake need device-motion permission on the
//     web and are not wired up; the promo flame has no gyro.
//   - Laptop typing, travel hops, and badge attention are app-internal
//     states (a live browser session, travelling between feed spots),
//     not promo-site states, so they are not ported.
//   - The speech bubble with the hello lines is promo garnish, not app
//     behaviour; everything else below is the app's behaviour.

(function () {
  var stage = document.getElementById("stage");
  var flame = document.getElementById("flame");
  var face = document.getElementById("face");
  var armL = document.getElementById("armL");
  var armR = document.getElementById("armR");
  var legL = document.getElementById("legL");
  var legR = document.getElementById("legR");
  var bubble = document.getElementById("bubble");
  var shadow = document.getElementById("shadow");
  if (!stage || !flame) return;

  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Dragging takes effect immediately: pickup happens as soon as the
  // finger has moved more than 4pt, with no 180ms rooted stretch
  // first. The spring physics themselves are unchanged — the body
  // still chases the handle on its spring, with stretch/morph,
  // joint flail, lean, and flick recoil all live. Only the pickup
  // delay is gone.

  // --- Repo constants -------------------------------------------------
  var PICKUP_DELAY = 0.18;          // FlameTouchPhysics.pickupDelay
  var REF_W = 210, REF_H = 262.5;    // reference rig, pt
  var JOINT_DEFS = [                 // FlameTouchJoint.defaults
    { k: 62,  d: 4,   len: 29, rest: 0.05,  limit: 1.05 },
    { k: 78,  d: 4.7, len: 33, rest: -0.05, limit: 1.05 },
    { k: 43,  d: 3.1, len: 38, rest: 0.22,  limit: 1.4 },
    { k: 53,  d: 3.6, len: 41, rest: -0.22, limit: 1.4 },
    { k: 110, d: 8,   len: 49, rest: 0,     limit: 0.22 },
    { k: 124, d: 9,   len: 48, rest: 0,     limit: 0.22 },
    { k: 95,  d: 7,   len: 70, rest: 0,     limit: 0.16 }
  ];
  // RiggedFlame attachment anchors, in reference pt.
  var ANCHORS = {
    legL: { x: 0.396 * REF_W, y: 0.656 * REF_H },
    legR: { x: 0.571 * REF_W, y: 0.656 * REF_H },
    armL: { x: 0.254 * REF_W, y: 0.559 * REF_H },
    armR: { x: 0.728 * REF_W, y: 0.559 * REF_H },
    torso: { x: 106.75, y: 134.1666667 }
  };
  var LIVELINESS = 1.35, JUMP = 24;   // FlameInteractionSettings defaults

  // --- Small vector helpers (FlamePoint) ------------------------------
  function pt(x, y) { return { x: x, y: y }; }
  function add(a, b) { return pt(a.x + b.x, a.y + b.y); }
  function sub(a, b) { return pt(a.x - b.x, a.y - b.y); }
  function mul(a, s) { return pt(a.x * s, a.y * s); }
  function len(a) { return Math.hypot(a.x, a.y); }
  function limited(a, limit) {
    var l = len(a);
    return l > limit ? mul(a, limit / l) : a;
  }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // --- FlameTouchPhysics, verbatim in structure -----------------------
  var P = {
    phase: "idle",
    body: pt(0, 0), bodyVel: pt(0, 0),
    handle: pt(0, 0), handleVel: pt(0, 0),
    grab: pt(0, 0), carryBlend: 0, lean: 0, leanVel: 0,
    joints: JOINT_DEFS.map(function (d) {
      return { angle: 0, vel: 0, k: d.k, d: d.d, len: d.len, rest: d.rest, limit: d.limit };
    }),
    home: pt(0, 0), target: pt(0, 0), translation: pt(0, 0),
    age: 0, mayCarry: false, samples: [], sampleTime: 0,
    placement: pt(0, 0) // web addition: committed drop position in the stage
  };

  function isHeld() { return P.phase === "stretching" || P.phase === "carrying"; }
  function isActive() { return P.phase !== "idle"; }
  function travel() { return len(P.translation); }

  function stretch() {
    var v = limited(sub(sub(P.handle, P.body), P.grab), 105);
    // Compression toward the rooted feet must not fold the texture.
    return v.y > 32 ? mul(v, 32 / v.y) : v;
  }

  function resetPhysics() {
    var placement = P.placement;
    P.phase = "idle";
    P.body = pt(0, 0); P.bodyVel = pt(0, 0);
    P.handle = pt(0, 0); P.handleVel = pt(0, 0);
    P.grab = pt(0, 0); P.carryBlend = 0; P.lean = 0; P.leanVel = 0;
    P.joints = JOINT_DEFS.map(function (d) {
      return { angle: 0, vel: 0, k: d.k, d: d.d, len: d.len, rest: d.rest, limit: d.limit };
    });
    P.home = pt(0, 0); P.target = pt(0, 0); P.translation = pt(0, 0);
    P.age = 0; P.mayCarry = false; P.samples = []; P.sampleTime = 0;
    P.placement = placement;
  }

  function begin(grabPt) {
    P.grab = grabPt;
    P.mayCarry = true; // the promo flame is movable, like the feed avatar
    P.home = P.body;
    P.target = add(P.body, grabPt);
    P.translation = pt(0, 0);
    P.handle = P.target;
    P.handleVel = P.bodyVel;
    P.carryBlend = 0;
    P.age = 0; P.pickupAt = 0; P.sampleTime = 0;
    P.samples = [{ p: pt(0, 0), t: 0 }];
    P.phase = "stretching";
  }

  // While carrying, he sits 40 screen px below the finger instead
  // of right under it, so the finger never covers him. The offset
  // is in screen px, converted to rig pt (40 / scale), so it is
  // 40px on any screen size. It only applies once he is picked up,
  // so a tap never moves him, and the spring carries him down to
  // it smoothly rather than snapping.
  function dragOffsetY() {
    if (P.phase !== "carrying") return 0;
    return 40 / scale;
  }

  function move(translationPt, time) {
    if (!isHeld() || time < P.sampleTime) return;
    P.translation = translationPt;
    P.target = add(add(add(P.home, P.grab), translationPt), pt(0, dragOffsetY()));
    P.samples.push({ p: translationPt, t: time });
    P.samples = P.samples.filter(function (s) { return time - s.t <= 0.16; });
    P.sampleTime = time;
  }

  function release(time) {
    if (!isHeld()) return;
    if (P.phase === "carrying" && P.age < PICKUP_DELAY && travel() > 5 && !reduced) {
      // A quick swipe released just after pickup is a flick, not a
      // carry: fall through to the recoil path below instead of
      // committing the drop point. A sustained carry commits.
      P.phase = "stretching";
    } else if (P.phase === "carrying") {
      // A carried release commits the drop point, including the
      // below-finger offset, so he stays where he was dropped
      // instead of snapping back up by the offset on release;
      // residual position and velocity settle relative to it.
      var committed = add(add(P.home, P.translation), pt(0, dragOffsetY()));
      P.body = sub(P.body, committed);
      P.handle = sub(P.handle, committed);
      P.placement = add(P.placement, committed);
      P.home = pt(0, 0);
      P.target = P.grab;
      P.phase = "settling";
      if (reduced) resetPhysics();
      return;
    }
    if (travel() > 5 && !reduced) {
      P.phase = "recoiling";
      var recent = P.samples.filter(function (s) { return time - s.t <= 0.10; });
      var first = recent[0], last = recent[recent.length - 1];
      if (first && last && last.t - first.t >= 0.008 && time - last.t < 0.07) {
        var vel = limited(mul(sub(last.p, first.p), 1 / (last.t - first.t)), 1250);
        P.handleVel = add(P.handleVel, mul(vel, 0.5));
      }
    } else {
      P.phase = "settling";
      if (reduced) resetPhysics();
    }
  }

  function advance(elapsed) {
    if (!isActive() || !(elapsed > 0)) return;
    P.age += Math.min(elapsed, 1);
    if (P.phase === "stretching" && P.mayCarry && travel() > 4) {
      // Immediate pickup: no 180ms wait. Pickup time is recorded
      // so the carry blend (and the anchor release) ramps from
      // this moment, and the spring starts chasing the finger on
      // this frame instead of after a rooted stretch.
      P.phase = "carrying";
      P.pickupAt = P.age;
    }
    if (reduced) {
      // Reduced Motion keeps pickup/drop available without deformation,
      // recoil, or swinging limbs.
      P.body = P.phase === "carrying" ? sub(P.target, P.grab) : P.home;
      P.handle = add(P.body, P.grab);
      P.bodyVel = pt(0, 0); P.handleVel = pt(0, 0);
      return;
    }
    // Bounded 240Hz substeps, independent of gesture event delivery.
    var remaining = Math.min(elapsed, 0.05);
    while (remaining > 0.000001) {
      var dt = Math.min(remaining, 1 / 240);
      step(dt);
      remaining -= dt;
    }
    if (!isHeld() && len(sub(P.body, P.home)) < 0.3 &&
        len(sub(sub(P.handle, P.body), P.grab)) < 0.3 &&
        len(P.bodyVel) + len(P.handleVel) < 0.4 &&
        P.joints.every(function (j) { return Math.abs(j.angle) + Math.abs(j.vel) < 0.02; })) {
      resetPhysics();
    }
  }

  function step(dt) {
    var oldVel = P.bodyVel;
    var carrying = P.phase === "carrying";
    var blend = carrying ? clamp((P.age - P.pickupAt) / 0.085, 0, 1) : 0;
    var soft = blend * blend * (3 - 2 * blend);
    var recoiling = P.phase === "recoiling";
    var k = recoiling ? 180 * 0.35 : 180;
    var damping = recoiling ? 8 * 0.8 : 8;
    var force = add(mul(sub(sub(P.handle, P.body), P.grab), k),
                    mul(sub(P.handleVel, P.bodyVel), damping));
    var handleForce = mul(force, -1);
    if (isHeld()) {
      var desired = add(add(P.body, P.grab),
                        limited(sub(sub(P.target, P.body), P.grab), 100 + soft * 40));
      handleForce = add(handleForce,
                        sub(mul(sub(desired, P.handle), 4500), mul(P.handleVel, 40)));
    }
    var anchorK = isHeld() ? 3200 * (1 - soft) : recoiling ? 3200 : 35;
    var anchorDamping = isHeld() ? 80 * (1 - soft) + 2 : recoiling ? 80 : 8;
    P.bodyVel = add(P.bodyVel, mul(add(add(force, mul(sub(P.home, P.body), anchorK)),
                                       mul(P.bodyVel, -anchorDamping)), dt));
    P.handleVel = add(P.handleVel, mul(handleForce, dt / (recoiling ? 1.3 : 0.18)));
    P.body = add(P.body, mul(P.bodyVel, dt));
    P.handle = add(P.handle, mul(P.handleVel, dt));
    P.carryBlend += ((carrying || P.phase === "settling" ? 1 : 0) - P.carryBlend) *
      Math.min(1, dt * 15);
    var accel = limited(mul(sub(P.bodyVel, oldVel), 1 / dt), 3500);
    var leanTarget = clamp(-P.bodyVel.x * 0.00042, -0.15, 0.15) * P.carryBlend;
    P.leanVel += (72 * (leanTarget - P.lean) - 10 * P.leanVel) * dt;
    P.lean += P.leanVel * dt;
    P.joints.forEach(function (j) {
      var drive = (accel.x * Math.cos(j.angle) + accel.y * Math.sin(j.angle)) / j.len;
      j.vel += (j.k * ((carrying ? j.rest : 0) - j.angle) - j.d * j.vel + drive * 0.92) * dt;
      j.angle += j.vel * dt;
      if (Math.abs(j.angle) > j.limit) {
        j.angle = clamp(j.angle, -j.limit, j.limit);
        j.vel *= 0.35;
      }
    });
  }

  // Forward deformation shared by the renderer and joint attachments.
  function displacement(at) {
    var local = sub(at, pt(106.75, 134.1666667));
    var distance = len(sub(local, P.grab));
    var lower = clamp(((at.y / REF_H - 0.2) / (560 / 900) - 0.48) / 0.42, 0, 1);
    var rooted = 1 - lower * lower * (3 - 2 * lower);
    var weight = Math.exp(-distance * distance / (2 * 65 * 65)) *
      (1 - 0.84 * P.carryBlend) * (rooted + (1 - rooted) * P.carryBlend);
    return mul(stretch(), weight);
  }

  // --- Faces (RiggedFlame.FlameFaceKind, all eight layers) --------------
  var FACES = {
    normal: "assets/flame/FlameRigFaceNormal.png",
    happy: "assets/flame/FlameRigFaceHappy.png",
    laugh: "assets/flame/FlameRigFaceLaugh.png",
    cry: "assets/flame/FlameRigFaceCry.png",
    sick: "assets/flame/FlameRigFaceSick.png",
    dizzy: "assets/flame/FlameRigFaceDizzy.png",
    surprised: "assets/flame/FlameRigFaceSurprised.png",
    sleepy: "assets/flame/FlameRigFaceSleepy.png"
  };
  Object.keys(FACES).forEach(function (k) {
    if (k === "normal") return;
    var img = new Image(); img.src = FACES[k];
  });
  function setFace(kind) {
    if (FACES[kind]) face.src = FACES[kind];
  }

  // Speech bubble: promo garnish only, shown on a tap as before.
  var lines = [
    "Hoo-gah!", "Hi, I’m Hygge!", "Pyt — Danish for “never mind.”",
    "Cozy is a full-time job, and I’m great at it.",
    "Put the kettle on, I’ll handle the boring bits.",
    "Somewhere between a nap and a paycheck.",
    "I run on coziness and good intentions.", "Blanket mode: on.",
    "My flame never goes out, it just naps.",
    "Yes, I have legs. They love a good walk.",
    "Two arms, for waving and high-fives.",
    "I’m small, but my to-do list is mighty.",
    "Careful — I’m warm, but friendly.", "I glow, therefore I am.",
    "Walking flame, reporting for cozy duty.",
    "Blink and I’ll still be here.", "Tap me again, I dare you.",
    "I like it here.", "I like work that likes you back.",
    "Looking for work you’d actually enjoy.",
    "The boring parts? Already on it.",
    "Applications are my love language.",
    "I read the long job posts so you don’t have to.",
    "One less form for you to fill in.", "Gig hunting, but make it cozy.",
    "Your calendar called. It wants more free evenings.",
    "Booked is my favourite word.", "No hustle, just help.",
    "I chase the gigs. You keep the evenings.",
    "Work that fits around life, not the other way round.",
    "Side quests welcome.", "Earning, minus the errands.",
    "More time for living.", "More evenings with your favourite people.",
    "Less admin, more together.", "Fewer worries, longer dinners.",
    "The people you love called. They miss you.",
    "Work pays for the good stuff. The good stuff is the point.",
    "I’m on fire today.", "It’s getting hot in here.",
    "I put the “lit” in “little.”", "Wick-ed good at this.",
    "Keep the home fires burning.", "Just embering along.",
    "I’m a real flare for the dramatic.", "Sparks fly when I get going.",
    "Burning the midnight oil? I AM the midnight oil.",
    "Hot stuff, coming through.", "I’m not hot-headed, just hot.",
    "Kindling good vibes."
  ];
  var deck = [], lastLine = null;
  function nextLine() {
    if (deck.length === 0) {
      deck = lines.slice();
      for (var i = deck.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var t = deck[i]; deck[i] = deck[j]; deck[j] = t;
      }
      if (lastLine && deck[0] === lastLine && deck.length > 1) {
        var t2 = deck[0]; deck[0] = deck[1]; deck[1] = t2;
      }
    }
    lastLine = deck.pop(); return lastLine;
  }
  var bubbleTimer = null;
  function say(text) {
    bubble.textContent = text;
    bubble.classList.add("show");
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(function () { bubble.classList.remove("show"); }, 3500); // stays up ~3.5s so the line is readable
  }

  // --- FlamePose (RiggedFlame.swift) + pose animation ------------------
  // A pose step is a full pose (missing fields = rest) plus the SwiftUI
  // animation that carries the flame into it, then a hold. Face, flipX
  // and backTurned switch at the step's start, as in SwiftUI: they are
  // discrete, not interpolated.
  function restPose() {
    return { dx: 0, dy: 0, sx: 1, sy: 1, rot: 0, flipX: 1,
             armSL: 0, armSR: 0, legSL: 0, legSR: 0,
             face: "normal", faceDX: 0, faceDY: 0, sickTint: 0, backTurned: false };
  }
  function mkPose(part) {
    var p = restPose();
    if (part) Object.keys(part).forEach(function (k) { p[k] = part[k]; });
    return p;
  }
  var pose = restPose();       // live pose, interpolated by the animator
  var poseFrom = restPose();   // animation start pose
  var poseTo = restPose();     // animation target pose
  var anim = null;             // {kind, dur, elapsed, springV, springX, hold}
  var poseToken = 0;           // cancels a reaction in flight
  var walking = false;         // walkAbout: TimelineView swing + bob

  function cubicBezier(t, x1, y1, x2, y2) {
    // Solve x(u)=t for the cubic bezier with control points
    // (x1,y1) and (x2,y2), then return y(u).
    var u = t;
    for (var i = 0; i < 8; i++) {
      var cx = 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
      var dx = 3 * (1 - u) * (1 - u) * x1 + 6 * (1 - u) * u * (x2 - x1) + 3 * u * u * (1 - x2);
      if (Math.abs(cx - t) < 0.0005 || dx === 0) break;
      u -= (cx - t) / dx;
    }
    u = clamp(u, 0, 1);
    return 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
  }
  function easeProgress(kind, t) {
    if (kind === "easeIn") return cubicBezier(t, 0.42, 0, 1, 1);
    if (kind === "easeOut") return cubicBezier(t, 0, 0, 0.58, 1);
    if (kind === "easeInOut") return cubicBezier(t, 0.42, 0, 0.58, 1);
    return t;
  }
  function startStep(step) {
    poseFrom = pose;
    poseTo = mkPose(step.pose);
    setFace(poseTo.face);
    // Discrete fields switch at step start.
    pose.flipX = poseTo.flipX; pose.backTurned = poseTo.backTurned;
    var dur = step.anim.dur || 0;
    if (step.anim.kind === "spring") dur = (step.anim.response || 0.3) * 4;
    anim = { kind: step.anim.kind, dur: dur,
             response: step.anim.response, damping: step.anim.damping,
             elapsed: 0, springV: 0, springX: 0, hold: step.hold || 0 };
    if (dur <= 0) { pose = poseTo; }
  }
  function advanceAnim(dt) {
    if (!anim) return;
    if (anim.elapsed < anim.dur) {
      anim.elapsed += dt;
      var t = anim.dur > 0 ? clamp(anim.elapsed / anim.dur, 0, 1) : 1;
      var k;
      if (anim.kind === "spring") {
        // Underdamped spring 0 -> 1: k = (2pi/response)^2,
        // c = 2 * dampingFraction * sqrt(k), integrated per frame.
        var w = 2 * Math.PI / anim.response;
        var c = 2 * anim.damping * w;
        var steps = Math.max(1, Math.ceil(dt / (1 / 240)));
        var sdt = dt / steps;
        for (var i = 0; i < steps; i++) {
          var acc = w * w * (1 - anim.springX) - c * anim.springV;
          anim.springV += acc * sdt; anim.springX += anim.springV * sdt;
        }
        k = anim.springX;
      } else {
        k = easeProgress(anim.kind, t);
      }
      var num = ["dx", "dy", "sx", "sy", "rot", "armSL", "armSR",
                 "legSL", "legSR", "faceDX", "faceDY", "sickTint"];
      num.forEach(function (f) {
        pose[f] = poseFrom[f] + (poseTo[f] - poseFrom[f]) * k;
      });
      pose.face = poseTo.face;
      if (t >= 1) {
        if (anim.kind === "spring") {
          var snap = ["dx", "dy", "sx", "sy", "rot", "armSL", "armSR",
                      "legSL", "legSR", "faceDX", "faceDY", "sickTint"];
          snap.forEach(function (f) { pose[f] = poseTo[f]; });
        }
        anim.elapsed = anim.dur;
      }
    } else {
      anim.hold -= dt;
      if (anim.hold <= 0) anim = null;
    }
  }
  function sleepMs(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  async function playSteps(steps, token) {
    for (var i = 0; i < steps.length; i++) {
      if (token !== poseToken) return;
      startStep(steps[i]);
      // Wait until this step's animation + hold have run out in the
      // render loop (anim becomes null), polling on animation frames.
      while (anim && token === poseToken) await new Promise(requestAnimationFrame);
    }
  }
  function rest() { poseToken += 1; }
  function A(kind, dur) { return { kind: kind, dur: dur }; }
  function S(response, damping) { return { kind: "spring", response: response, damping: damping }; }
  function poseStep(posePart, anim, hold) { return { pose: posePart, anim: anim, hold: hold }; }
  function hopSteps(height, faceKind) {
    return [
      poseStep({ dy: 3, sx: 1.07, sy: 0.91 }, A("easeIn", 0.09), 0.09),
      poseStep({ dy: -height, sx: 0.96, sy: 1.05, face: faceKind || "happy",
             armSL: 95, armSR: -95, legSL: 14, legSR: -14 }, A("easeOut", 0.18), 0.18),
      poseStep({ dy: 2, sx: 1.08, sy: 0.9, face: faceKind || "happy" }, A("easeIn", 0.1), 0.1)
    ];
  }

  // --- FlameActor.run(): every reaction scene, verbatim -----------------
  // jump = jumpHeight * live, live = liveliness * intensity.
  // liveliness 1.35, jumpHeight 24 (FlameInteractionSettings defaults).
  var LIVELINESS2 = 1.35, JUMP_HEIGHT = 24;
  async function runReaction(reaction, direction, intensity) {
    var d = direction === 0 ? 1 : direction;
    var live = LIVELINESS2 * intensity;
    var jump = JUMP_HEIGHT * live;
    var token = poseToken;
    var steps = [];
    function add(p, anim, hold) { steps.push(poseStep(p, anim, hold)); }
    if (reaction === "pat") {
      add({ dy: 2, sx: 1.12, sy: 0.82, face: "happy", armSL: 22, armSR: -22 }, A("easeIn", 0.12), 0.14);
      add({ dy: -2, sx: 0.96, sy: 1.06, face: "happy" }, S(0.3, 0.55), 0.35);
    } else if (reaction === "poke") {
      add({ dx: d * 9 * live, rot: d * 6, face: "surprised", armSL: 120, armSR: -120, legSL: 10, legSR: -10 }, A("easeOut", 0.1), 0.12);
      add({ dx: -d * 2, rot: -d * 2 }, S(0.35, 0.5), 0.35);
    } else if (reaction === "footTapDance") {
      for (var i = 0; i < 4; i++) {
        var left = i % 2 === 0;
        add({ face: "happy", dy: -3, legSL: left ? 42 : -8, legSR: left ? 8 : -42,
              armSL: left ? -18 : 30, armSR: left ? -30 : 18, rot: left ? -3 : 3 }, A("easeInOut", 0.1), 0.1);
      }
      steps = steps.concat(hopSteps(jump * 0.4, "happy"));
    } else if (reaction === "miniHop") {
      steps = steps.concat(hopSteps(jump * 0.45, "happy"));
    } else if (reaction === "bigJump") {
      add({ dy: 4, sx: 1.1, sy: 0.86, legSL: 16, legSR: -16 }, A("easeIn", 0.11), 0.11);
      add({ dy: -jump, sx: 0.95, sy: 1.06, rot: -4, face: "laugh", armSL: 150, armSR: -150, legSL: 22, legSR: -22 }, A("easeOut", 0.22), 0.24);
      add({ dy: 2, sx: 1.1, sy: 0.88, face: "happy" }, A("easeIn", 0.12), 0.12);
      add({ dy: -jump * 0.18, face: "happy", armSL: 60, armSR: -60 }, S(0.3, 0.6), 0.3);
    } else if (reaction === "duck") {
      add({ dy: 8, sx: 1.14, sy: 0.78, face: "sleepy", armSL: 30, armSR: -30, legSL: 22, legSR: -22 }, A("easeIn", 0.14), 0.32);
      add({ dy: 4, sx: 1.07, sy: 0.9, face: "normal" }, A("easeOut", 0.12), 0.2);
    } else if (reaction === "sideHop") {
      add({ dy: 3, sx: 1.08, sy: 0.9 }, A("easeIn", 0.09), 0.09);
      add({ dx: d * 17 * live, dy: -jump * 0.55, rot: d * 7, face: "happy",
            armSL: d < 0 ? 140 : 30, armSR: d < 0 ? -30 : -140, legSL: 24, legSR: -24 }, A("easeOut", 0.2), 0.2);
      add({ dx: d * 10, dy: 2, sx: 1.09, sy: 0.89, face: "happy" }, A("easeIn", 0.11), 0.11);
    } else if (reaction === "twirl") {
      add({ flipX: 0.05, dy: -jump * 0.25, armSL: 80, armSR: -80 }, A("easeIn", 0.16), 0.16);
      add({ flipX: -1, backTurned: true, armSL: 80, armSR: -80 }, A("easeOut", 0.16), 0.18);
      add({ flipX: -0.05, backTurned: true, dy: -jump * 0.15 }, A("easeIn", 0.16), 0.16);
      add({ face: "dizzy" }, S(0.32, 0.6), 0.35);
    } else if (reaction === "wiggle") {
      [-7, 7, -5, 5, -2].forEach(function (r) {
        add({ dy: -2, rot: r, face: "laugh", armSL: 40 + r * 3, armSR: -40 + r * 3 }, A("easeInOut", 0.07), 0.07);
      });
    } else if (reaction === "stretch") {
      add({ dy: -3, sx: 0.93, sy: 1.12, face: "sleepy", armSL: 165, armSR: -165 }, A("easeInOut", 0.3), 0.6);
      add({ face: "happy" }, S(0.35, 0.6), 0.3);
    } else if (reaction === "puffUp") {
      add({ dy: -2, sx: 1.18, sy: 1.18, face: "happy", armSL: 52, armSR: -52, legSL: 14, legSR: -14 }, S(0.32, 0.6), 0.45);
    } else if (reaction === "shrinkStartle") {
      add({ dy: 3, sx: 0.8, sy: 0.8, face: "surprised", armSL: 130, armSR: -130 }, A("easeIn", 0.1), 0.2);
      add({ sx: 1.04, sy: 1.04 }, S(0.3, 0.55), 0.3);
    } else if (reaction === "dizzy") {
      [-10, 10, -8, 8, -4].forEach(function (r) {
        add({ dx: r * 0.4, sy: 0.97, rot: r, face: "dizzy", armSL: 60 + r * 2, armSR: -60 + r * 2 }, A("easeInOut", 0.13), 0.13);
      });
    } else if (reaction === "wave") {
      [-152, -118, -152, -118, -152].forEach(function (a) {
        add({ face: "happy", armSR: a, armSL: 14, dy: -1 }, A("easeInOut", 0.14), 0.14);
      });
      steps = steps.concat(hopSteps(jump * 0.3, "happy"));
    } else if (reaction === "pointUp") {
      add({ face: "laugh", armSL: 148, armSR: -24, rot: -3, faceDX: -4.2, faceDY: -2.94 }, A("easeOut", 0.16), 0.2);
      steps = steps.concat(hopSteps(jump * 0.55, "laugh"));
      add({ face: "happy", armSL: 148, armSR: -24, rot: -3, faceDX: -4.2, faceDY: -2.94 }, A("easeInOut", 0.18), 0.35);
    } else if (reaction === "laugh") {
      for (var li = 0; li < 3; li++) {
        var up = li % 2 === 0;
        add({ face: "laugh", dy: up ? -4 : 0, sy: up ? 1.03 : 0.98, armSL: 34, armSR: -34 }, A("easeInOut", 0.11), 0.11);
      }
    } else if (reaction === "cry") {
      add({ face: "cry", dy: 3, sy: 0.95, armSL: 8, armSR: -8 }, A("easeInOut", 0.25), 0.5);
      for (var ci = 0; ci < 2; ci++) {
        add({ face: "cry", dy: 4, sy: 0.93 }, A("easeInOut", 0.14), 0.14);
        add({ face: "cry", dy: 2, sy: 0.96 }, A("easeInOut", 0.14), 0.14);
      }
    } else if (reaction === "nauseous") {
      add({ face: "sick", sickTint: 0.55, dy: 2, rot: -6, armSL: -28, armSR: 28 }, A("easeInOut", 0.25), 0.3);
      [6, -5, 3].forEach(function (r) {
        add({ face: "sick", sickTint: 0.55, rot: r, dy: 2, armSL: -28, armSR: 28 }, A("easeInOut", 0.28), 0.28);
      });
      add({ face: "dizzy", sickTint: 0.2 }, A("easeOut", 0.3), 0.3);
    } else if (reaction === "turnAround") {
      add({ flipX: 0.05 }, A("easeIn", 0.16), 0.16);
      add({ flipX: -1, backTurned: true, armSL: 46, armSR: -46 }, A("easeOut", 0.16), 0.55);
      add({ flipX: -0.05, backTurned: true }, A("easeIn", 0.16), 0.16);
      add({ face: "happy" }, S(0.32, 0.6), 0.3);
    } else if (reaction === "walkAbout") {
      walking = true;
      add({ dx: d * 22 * live, face: "normal" }, A("easeInOut", 0.7), 0.7);
      add({ face: "happy" }, A("easeInOut", 0.7), 0.7);
    }
    await playSteps(steps, token);
    if (token !== poseToken) return;
    // FlameActor.rest(): spring back to rest, then the reaction ends.
    await playSteps([poseStep({}, S(0.38, 0.62), 0.38)], token);
    walking = false;
  }
  // FlameActor.perform(): a reaction never starts while a touch is held,
  // and a new touch cancels the one in flight.
  function perform(reaction, direction, intensity) {
    if (reduced || reaction === "none" || isHeld()) return;
    lastInteraction = performance.now();
    poseToken += 1;
    runReaction(reaction, direction, intensity);
  }
  // Default gesture -> reaction mapping (FlameInteractionSettings).
  var DEFAULT_REACTIONS = {
    tapHead: "pat", tapBody: "poke", tapFeet: "footTapDance",
    doubleTap: "laugh", longPress: "wave",
    swipeUp: "bigJump", swipeDown: "duck", swipeLeft: "sideHop", swipeRight: "sideHop",
    pinchIn: "shrinkStartle", pinchOut: "puffUp", shake: "nauseous"
  };
  function fire(gesture, direction, intensity) {
    perform(DEFAULT_REACTIONS[gesture] || "none", direction, intensity);
  }

  // --- Idle life (FlameActor.runIdleLoop + FlameIdlePlanner) -----------
  // Shuffled bag, every action once per bag, never twice in a row
  // (including across bags). LCG matches FlamePlay's planner exactly.
  var IDLE_ACTIONS = ["lookLeft", "footTap", "lookRight", "stretch", "miniHop", "wiggle",
                      "wave", "laugh", "pointUp", "walkAbout", "turnAround", "yawn"];
  var IDLE_DELAY = { lookLeft: 0.85, footTap: 1.15, lookRight: 0.7, stretch: 1.3,
                     miniHop: 1.0, wiggle: 0.9, wave: 1.2, laugh: 1.1,
                     pointUp: 1.0, walkAbout: 1.4, turnAround: 1.25, yawn: 1.5 };
  var idleBag = [], idleIndex = 0, idleLast = null, idleState = 0x9E3779B97F4A7C15n;
  function idleNextRandom() {
    idleState = (idleState * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
    return Number(idleState >> 33n);
  }
  function idleNext() {
    if (idleIndex >= idleBag.length) {
      var fresh = IDLE_ACTIONS.slice();
      for (var i = fresh.length - 1; i > 0; i--) {
        var j = idleNextRandom() % (i + 1);
        var t = fresh[i]; fresh[i] = fresh[j]; fresh[j] = t;
      }
      if (fresh.length > 1 && fresh[0] === idleLast) {
        var t2 = fresh[0]; fresh[0] = fresh[1]; fresh[1] = t2;
      }
      idleBag = fresh; idleIndex = 0;
    }
    var a = idleBag[idleIndex++]; idleLast = a; return a;
  }
  async function runIdleAction(action) {
    var token = poseToken;
    var steps = [];
    if (action === "lookLeft") {
      steps = [poseStep({ faceDX: -4.62, rot: -2.5, dx: -3 }, A("easeInOut", 0.3), 0.8)];
    } else if (action === "lookRight") {
      steps = [poseStep({ faceDX: 4.62, rot: 2.5, dx: 3 }, A("easeInOut", 0.3), 0.8)];
    } else if (action === "footTap") {
      for (var i = 0; i < 3; i++) {
        steps.push(poseStep({ legSR: i % 2 === 0 ? -30 : 0, dy: -1 }, A("easeInOut", 0.1), 0.12));
      }
    } else if (action === "stretch") {
      steps = [poseStep({ dy: -2, sx: 0.96, sy: 1.07, face: "sleepy", armSL: 150, armSR: -150 }, A("easeInOut", 0.35), 0.7)];
    } else if (action === "miniHop") {
      steps = hopSteps(7 * LIVELINESS2, "normal");
    } else if (action === "wiggle") {
      [-3.5, 3.5, -2].forEach(function (r) {
        steps.push(poseStep({ rot: r, face: "happy", armSL: 18, armSR: -18 }, A("easeInOut", 0.1), 0.1));
      });
    } else if (action === "yawn") {
      steps = [poseStep({ face: "sleepy", sx: 0.97, sy: 1.06, dy: -2, armSL: 132, armSR: -118 }, A("easeInOut", 0.5), 1.0)];
    } else if (action === "wave") {
      await runReaction("wave", 1, 1 / LIVELINESS2); return;
    } else if (action === "laugh") {
      await runReaction("laugh", 0, 1 / LIVELINESS2); return;
    } else if (action === "pointUp") {
      await runReaction("pointUp", -1, 1 / LIVELINESS2); return;
    } else if (action === "walkAbout") {
      await runReaction("walkAbout", Math.random() < 0.5 ? 1 : -1, 1 / LIVELINESS2); return;
    } else if (action === "turnAround") {
      await runReaction("turnAround", 0, 1 / LIVELINESS2); return;
    }
    await playSteps(steps, token);
    if (token !== poseToken) return;
    await playSteps([poseStep({}, S(0.38, 0.62), 0.38)], token);
  }
  // Idle loop: first wait 2.5s, then wait idleInterval * delayFactor /
  // liveliness between actions, and only act after 3s of quiet with no
  // reaction running and no touch held.
  async function idleLoop() {
    await sleepMs(2500);
    while (true) {
      var action = idleNext();
      var wait = 5000 * IDLE_DELAY[action] / Math.max(0.5, LIVELINESS2);
      await sleepMs(wait);
      if (!reduced && !isHeld() && !anim && performance.now() - lastInteraction > 3000) {
        await runIdleAction(action);
      }
    }
  }

  // --- Pointer handling (FlameActor.dragGesture, pinch, long-press) ----
  var scale = 1; // px per pt, from the stage width
  function measure() { scale = stage.clientWidth / REF_W; }
  measure();
  window.addEventListener("resize", measure);

  var pointers = new Map(); // pointerId -> {x, y}
  var primaryId = null, startX = 0, startY = 0, startNormY = 0, startClientX = 0;
  var downAt = 0, lastTapAt = 0, longPressTimer = null, longPressFired = false;
  var dragging = false, pinching = false, pinchScale = 1, pinchStartDist = 0;
  var lastInteraction = performance.now();
  var touchStartedAt = 0, spinAccum = 0, lastDragAngle = null, pendingNausea = false;
  var lastPinchEnd = -10000;

  function stagePoint(e) {
    var rect = stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top, rect: rect };
  }
  function beginTouch(e) {
    var p = stagePoint(e);
    startX = e.clientX; startY = e.clientY; startClientX = e.clientX;
    startNormY = p.rect.height > 0 ? p.y / p.rect.height : 0.5;
    downAt = performance.now();
    touchStartedAt = downAt / 1000;
    // FlameActor.beginTouch: grab is rig-local, relative to the flame's
    // current placement, minus the rig centre (106.75, 134.1666667).
    var offX = (P.placement.x + P.body.x) * scale;
    var offY = (P.placement.y + P.body.y) * scale;
    begin(pt((p.x - offX) / scale - 106.75, (p.y - offY) / scale - 134.1666667));
    spinAccum = 0; lastDragAngle = null; pendingNausea = false;
  }
  function trackSpin(clientX, clientY) {
    var rect = stage.getBoundingClientRect();
    var cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    var a = Math.atan2(clientY - cy, clientX - cx);
    if (lastDragAngle !== null) {
      var d = a - lastDragAngle;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      spinAccum += d;
      if (Math.abs(spinAccum) > 4.7) pendingNausea = true;
    }
    lastDragAngle = a;
  }
  function isDoubleTap(now) {
    if (!lastTapAt) return false;
    var gap = (now - lastTapAt) / 1000;
    return gap >= 0 && gap <= 0.45;
  }

  stage.addEventListener("pointerdown", function (e) {
    measure();
    lastInteraction = performance.now();
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      // FlameActor.pinchGesture: a pinch cancels the touch.
      pinching = true; pinchStartDist = 0;
      var pts = Array.from(pointers.values());
      pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      dragging = false; clearTimeout(longPressTimer);
      P.phase = "idle"; resetPhysics();
      return;
    }
    if (pinching) return;
    primaryId = e.pointerId;
    dragging = true;
    poseToken += 1; // a new touch cancels any reaction in flight
    pose = restPose(); anim = null; walking = false;
    beginTouch(e);
    stage.setPointerCapture(e.pointerId);
    // LongPressGesture: 0.6s, max 12pt of movement, and only when the
    // flame has not been dragged (FlameActor checks travel <= 5).
    longPressFired = false;
    clearTimeout(longPressTimer);
    longPressTimer = setTimeout(function () {
      if (dragging && !longPressFired && travel() <= 5) {
        // App's LongPressGesture fires on release after the hold;
        // here we only arm it — the wave plays in endPointer.
        longPressFired = true;
      }
    }, 600);
  });

  stage.addEventListener("pointermove", function (e) {
    lastInteraction = performance.now();
    if (pinching && pointers.has(e.pointerId)) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      var pts = Array.from(pointers.values());
      if (pts.length === 2) {
        var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        pinchScale = clamp(dist / pinchStartDist, 0.6, 1.6);
      }
      return;
    }
    if (!dragging || e.pointerId !== primaryId) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    var dxPt = (e.clientX - startX) / scale;
    var dyPt = (e.clientY - startY) / scale;
    if (Math.hypot(dxPt, dyPt) > 12) clearTimeout(longPressTimer);
    move(pt(dxPt, dyPt), (performance.now() - downAt) / 1000);
    if (P.phase === "carrying") trackSpin(e.clientX, e.clientY);
  });

  function endPointer(e) {
    if (pinching) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) {
        pinching = false; lastPinchEnd = performance.now();
        // Spring back to 1, then fire the pinch reaction if it passed
        // the app's thresholds (FlameActor.pinchGesture).
        var mag = pinchScale; pinchScale = 1;
        if (mag < 0.82) fire("pinchIn", 0, 1);
        else if (mag > 1.18) fire("pinchOut", 0, 1);
      }
      return;
    }
    if (!dragging || e.pointerId !== primaryId) return;
    dragging = false;
    pointers.delete(e.pointerId);
    clearTimeout(longPressTimer);
    lastInteraction = performance.now();
    if (!isHeld()) return;
    var now = performance.now();
    var time = (now - downAt) / 1000;
    move(pt((e.clientX - startX) / scale, (e.clientY - startY) / scale), time);
    var wasCarrying = P.phase === "carrying";
    var moved = travel() > 5;
    release(time);
    if (longPressFired) {
      // FlameActor: cancelTouch() first, then fire the wave.
      longPressFired = false;
      fire("longPress", 0, 1);
      return;
    }
    if (wasCarrying) {
      // Committed placement is handled inside release(); a spin past
      // 4.7 rad turns the drop into a nauseous reaction.
      if (pendingNausea) fire("shake", 0, 1.2);
      return;
    }
    // FlameActor: a short swipe is the spring's continued stretch,
    // never a second hop/jump scene or a placement change.
    if (moved) return;
    if (now - lastPinchEnd <= 300) return;
    // Tap classification: travel < 12pt reads as a tap in the zone it
    // landed in (y: 0 top, 1 feet). Predicted end = translation in
    // FlameActor, so a tap never classifies as a swipe here.
    var travelPt = Math.hypot((e.clientX - startX) / scale, (e.clientY - startY) / scale);
    if (travelPt < 12 && !reduced) {
      var second = isDoubleTap(now);
      var direction = startClientX - stage.getBoundingClientRect().left < stage.clientWidth * 0.5 ? 1 : -1;
      if (second) {
        lastTapAt = 0;
        fire("doubleTap", direction, 1.15);
      } else {
        lastTapAt = now;
        var zone = startNormY < 0.34 ? "tapHead" : startNormY > 0.78 ? "tapFeet" : "tapBody";
        // Tap intensity in FlameActor: min(1.5, max(0.8, predicted/220))
        // with predicted = travel, so a tap's intensity is 0.8.
        fire(zone, direction, 0.8);
        say(nextLine());
      }
    }
  }
  stage.addEventListener("pointerup", endPointer);
  stage.addEventListener("pointercancel", function (e) {
    pointers.delete(e.pointerId);
    if (pinching) { pinching = false; pinchScale = 1; return; }
    dragging = false;
    clearTimeout(longPressTimer);
    P.phase = "idle"; resetPhysics();
  });

  // Page-zoom guards, for touches outside the stage (the stage itself
  // already has touch-action: none): iOS gesture events, and a second
  // touchend within 300ms, which is what browsers read as double-tap
  // zoom. Flame drag, tap, double-tap and pinch all run on pointer
  // events on the stage, so these guards do not take them away.
  document.addEventListener("gesturestart", function (e) { e.preventDefault(); }, { passive: false });
  var lastTouchEnd = 0;
  document.addEventListener("touchend", function (e) {
    var now = performance.now();
    if (now - lastTouchEnd <= 300) e.preventDefault();
    lastTouchEnd = now;
  }, { passive: false });

  // --- Render loop ------------------------------------------------------
  var lastFrame = performance.now();
  var breathT = 0;
  var hoverAmp = 0; // eased 0..1: hover fades in while idle, out on any gesture
  function render(now) {
    var dt = Math.min((now - lastFrame) / 1000, 0.05);
    lastFrame = now;
    advance(dt);
    advanceAnim(dt);
    breathT += dt;

    // Breath: 1.7s easeInOut, autoreversing — scale 0.995 / 1.02, bottom-anchored.
    var b = reduced ? 0 : (1 - Math.cos((breathT / 3.4) * Math.PI * 2)) / 2;
    var bx = 1 - 0.005 * b, by = 1 + 0.02 * b;

    // Walking swing + bob (RiggedFlame TimelineView, 7.5 rad/s).
    var swing = 0, bob = 0;
    if (walking && !reduced) {
      var t = now / 1000;
      swing = Math.sin(t * 7.5);
      bob = -Math.abs(Math.cos(t * 7.5)) * REF_W * 0.018;
    }

    var px = (P.placement.x + P.body.x + pose.dx) * scale;
    // Hover: a slow, gentle vertical float while idle (3.5s period,
    // 4px), so he never sits completely still between idle
    // movements. Only when idle — never while held, dragged or
    // settling — and eased in/out so it never pops when a gesture
    // starts or ends. The shadow and bubble follow through py.
    hoverAmp += ((P.phase === "idle" && !reduced ? 1 : 0) - hoverAmp) * Math.min(dt * 3, 1);
    var hover = Math.sin(now / 1000 * (Math.PI * 2 / 3.5)) * 4 * hoverAmp;
    var py = (P.placement.y + P.body.y + pose.dy + bob) * scale + hover;
    var leanDeg = P.lean * 180 / Math.PI;
    flame.style.transform =
      "translate(" + px + "px, " + py + "px) " +
      "rotate(" + (leanDeg + pose.rot) + "deg) " +
      "scale(" + (bx * pose.sx * pose.flipX * pinchScale) + ", " + (by * pose.sy * pinchScale) + ")";
    if (face) face.style.display = pose.backTurned ? "none" : "";

    // Speech bubble: centred above his head, following him wherever
    // he is dragged, hops, or walks. left is his centre in stage px,
    // top is the top of the flame; the CSS transform hangs the
    // bubble above that point. It stays hidden (opacity 0) until a
    // tap shows it, so positioning it every frame is harmless.
    // Clamped to the viewport: near an edge the bubble slides
    // sideways / down just enough to stay fully on screen, instead
    // of crossing out of it. The clamp is in viewport coordinates
    // (stage rect + window size), then converted back to stage px.
    if (bubble) {
      var bw = bubble.offsetWidth || 200;
      var bh = bubble.offsetHeight || 60;
      var vw = window.innerWidth || stage.clientWidth || 390;
      var vh = window.innerHeight || stage.clientHeight || 844;
      var rect = stage.getBoundingClientRect();
      var margin = 8;
      var centreVX = rect.left + stage.clientWidth / 2 + px;
      var topVY = rect.top + py - bh;
      centreVX = clamp(centreVX, margin + bw / 2, Math.max(margin + bw / 2, vw - margin - bw / 2));
      topVY = clamp(topVY, margin, Math.max(margin, vh - margin - bh));
      bubble.style.left = String(centreVX - rect.left) + "px";
      bubble.style.top = String(topVY + bh - rect.top) + "px";
    }

    // Limbs: joint angles + pose limb angles (+ walking swing),
    // plus the displacement at each anchor point — but never far
    // from the torso's own displacement. On the web the torso is
    // rigid, not warped by the app's Metal shader, so an uncapped
    // per-anchor displacement lets a limb's anchor drift away from
    // the torso on a fast drag and visibly disconnect. Capping the
    // gap at 10pt keeps every joint attached while the joint
    // rotation still carries the flailing.
    var torsoD = displacement(ANCHORS.torso);
    function layer(el, jointDeg, poseDeg, swingDeg, anchor) {
      if (!el) return;
      var d = displacement(anchor);
      var gap = sub(d, torsoD);
      var gapLen = len(gap);
      if (gapLen > 10) d = add(torsoD, mul(gap, 10 / gapLen));
      el.style.transform =
        "translate(" + (d.x * scale) + "px, " + (d.y * scale) + "px) " +
        "rotate(" + (jointDeg + poseDeg + swingDeg) + "deg)";
    }
    var deg = function (rad) { return rad * 180 / Math.PI; };
    layer(legL, deg(P.joints[0].angle), pose.legSL, swing * 26, ANCHORS.legL);
    layer(legR, deg(P.joints[1].angle), pose.legSR, -swing * 26, ANCHORS.legR);
    layer(armL, deg(P.joints[2].angle), pose.armSL, -swing * 16, ANCHORS.armL);
    layer(armR, deg(P.joints[3].angle), pose.armSR, swing * 16, ANCHORS.armR);
    var torsoT = "translate(" + (torsoD.x * scale) + "px, " + (torsoD.y * scale) + "px)";
    var bodyEl = flame.querySelector(".layer.body");
    if (bodyEl) {
      bodyEl.style.transform = torsoT;
      // App overlays a sick tint on the body during nausea; the web
      // approximates it with a filter while sickTint is up.
      bodyEl.style.filter = pose.sickTint > 0.05
        ? "sepia(0.55) hue-rotate(55deg) saturate(1.4)" : "";
    }
    if (face) {
      face.style.transform = "translate(" +
        ((torsoD.x + pose.faceDX) * scale) + "px, " +
        ((torsoD.y + pose.faceDY) * scale) + "px)";
    }

    // Ground shadow follows him horizontally (placement + body +
    // pose offset) and stays on the ground vertically. How high he
    // is above the ground is measured from his feet: at rest his
    // feet sit just above the shadow line, so height is ~0 there.
    // Higher up, the shadow gets fainter, smaller and more blurred
    // (more obfuscated with height). Dragged below the shadow line,
    // his feet are under the ground, so the shadow fades out and
    // disappears. py is his total vertical offset (placement +
    // body + pose + bob), in px, positive down.
    if (shadow) {
      var stageH = stage.clientHeight || REF_H * scale;
      var shadowY = stageH * 1.01 - 11; // centre of the 22px shadow, 1% below the stage
      var feetY = stageH * 0.9 + py;    // his feet, ~90% down the rig
      var centreY = stageH * 0.5 + py;  // his middle
      var heightPt = (shadowY - feetY) / scale;
      var opacity, blurPx, shrink;
      if (heightPt >= 0) {
        // Above the ground: fainter and more blurred the higher he is.
        opacity = 1 - 0.7 * clamp(heightPt / 120, 0, 1);
        blurPx = clamp(heightPt / 25, 0, 6);
        shrink = 1 - 0.25 * clamp(heightPt / 120, 0, 1);
      } else {
        // Feet below the ground line, body still above it: the shadow
        // must not vanish yet — there is still space between him and
        // it. It fades out as his body comes down onto the line, and
        // is gone only when his centre is right over it.
        var spanPt = (feetY - centreY) / scale;
        opacity = clamp(1 + heightPt / spanPt, 0, 1);
        blurPx = 0;
        shrink = 1;
      }
      // No calc() here: Safari mishandles calc() inside translate(),
      // silently dropping the pixel offset and leaving the shadow
      // centred. Two plain translateX calls compose the same way.
      shadow.style.transform = "translateX(-50%) translateX(" + px + "px) scale(" + shrink + ")";
      shadow.style.opacity = String(opacity);
      shadow.style.filter = blurPx > 0.05 ? "blur(" + blurPx.toFixed(1) + "px)" : "";
    }
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);
  idleLoop();
})();
