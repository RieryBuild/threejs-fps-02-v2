// Keyboard and mouse input: a key set, a look delta queue and a pressed
// queue the fixed step consumes. Pointer lock is requested by the play
// button; the game never reads the mouse outside the lock.
export function createInput(canvas, onLockChange) {
  const keys = new Set();
  const pressed = new Set();
  let lookX = 0;
  let lookY = 0;
  let firing = false;

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    keys.add(e.code);
    pressed.add(e.code);
    if (e.code === 'Space') e.preventDefault();
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => {
    keys.clear();
    firing = false;
  });
  document.addEventListener('pointerlockchange', () => {
    onLockChange(document.pointerLockElement === canvas);
  });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement !== canvas) return;
    lookX += e.movementX;
    lookY += e.movementY;
  });
  canvas.addEventListener('mousedown', (e) => {
    if (document.pointerLockElement === canvas && e.button === 0) firing = true;
  });
  window.addEventListener('mouseup', (e) => {
    if (e.button === 0) firing = false;
  });

  return {
    state: { keys, firing: false },
    takeLook() {
      const out = { x: lookX, y: lookY };
      lookX = 0;
      lookY = 0;
      return out;
    },
    takePressed() {
      const out = new Set(pressed);
      pressed.clear();
      return out;
    },
    syncFiring() {
      const locked = document.pointerLockElement === canvas;
      this.state.firing = firing && locked;
    },
    requestLock() {
      canvas.requestPointerLock();
    },
  };
}
