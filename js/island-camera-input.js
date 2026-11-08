const KEY_ACTIONS = Object.freeze({
  KeyW: 'forward',
  ArrowUp: 'forward',
  KeyS: 'backward',
  ArrowDown: 'backward',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  Space: 'jump',
  KeyE: 'up',
  KeyQ: 'down',
  ControlLeft: 'down'
});

const EDGE_KEYS = Object.freeze({
  KeyV: 'toggleView',
  KeyF: 'toggleFlight',
  Digit1: 'person',
  Digit3: 'seagull'
});

const clampAxis = (value) => Math.abs(value) < 0.16 ? 0 : Math.sign(value) * ((Math.abs(value) - 0.16) / 0.84);

export class IslandCameraInput {
  constructor(canvas, { windowTarget = window, documentTarget = document } = {}) {
    this.canvas = canvas;
    this.windowTarget = windowTarget;
    this.documentTarget = documentTarget;
    this.actions = new Set();
    this.edges = new Set();
    this.mouseLookX = 0;
    this.mouseLookY = 0;
    this.mouseZoom = 0;
    this.mouseAiming = false;
    this.mouseDrag = null;
    this.aimToggled = false;
    this.touchLook = null;
    this.destroyed = false;

    this.onKeyDown = (event) => {
      if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const action = KEY_ACTIONS[event.code] || EDGE_KEYS[event.code];
      if (!action) return;
      event.preventDefault();
      if (EDGE_KEYS[event.code]) {
        if (!event.repeat) this.edges.add(action);
        return;
      }
      if (!this.actions.has(action) && action === 'jump') this.edges.add('jump');
      this.actions.add(action);
    };
    this.onKeyUp = (event) => {
      const action = KEY_ACTIONS[event.code];
      if (action) this.actions.delete(action);
    };
    this.onPointerDown = (event) => {
      if (event.pointerType === 'touch') {
        this.touchLook = { id: event.pointerId, x: event.clientX, y: event.clientY };
        this.canvas.setPointerCapture?.(event.pointerId);
      } else if (event.button === 0 || event.button === 2) {
        this.mouseDrag = { id: event.pointerId, x: event.clientX, y: event.clientY };
        this.canvas.classList.add('camera-dragging');
        this.canvas.setPointerCapture?.(event.pointerId);
      }
      if (event.button === 2) {
        event.preventDefault();
        this.mouseAiming = true;
      }
    };
    this.onPointerUp = (event) => {
      if (event.button === 2) this.mouseAiming = false;
      if (this.mouseDrag?.id === event.pointerId) {
        this.mouseDrag = null;
        this.canvas.classList.remove('camera-dragging');
      }
    };
    this.onContextMenu = (event) => event.preventDefault();
    this.onWheel = (event) => {
      this.mouseZoom += Math.sign(event.deltaY);
    };
    this.onPointerMove = (event) => {
      if (this.touchLook?.id === event.pointerId) {
        this.mouseLookX += (event.clientX - this.touchLook.x) * 2.7;
        this.mouseLookY += (event.clientY - this.touchLook.y) * 2.7;
        this.touchLook.x = event.clientX;
        this.touchLook.y = event.clientY;
        return;
      }
      if (this.mouseDrag?.id !== event.pointerId) return;
      this.mouseLookX += event.clientX - this.mouseDrag.x;
      this.mouseLookY += event.clientY - this.mouseDrag.y;
      this.mouseDrag.x = event.clientX;
      this.mouseDrag.y = event.clientY;
    };
    this.onPointerEnd = (event) => {
      if (this.touchLook?.id === event.pointerId) this.touchLook = null;
      if (this.mouseDrag?.id === event.pointerId) {
        this.mouseDrag = null;
        this.canvas.classList.remove('camera-dragging');
      }
      this.mouseAiming = false;
    };
    this.onBlur = () => {
      this.actions.clear();
      this.edges.clear();
      this.mouseAiming = false;
      this.mouseDrag = null;
      this.touchLook = null;
      this.canvas.classList.remove('camera-dragging');
    };

    this.windowTarget.addEventListener('keydown', this.onKeyDown);
    this.windowTarget.addEventListener('keyup', this.onKeyUp);
    this.windowTarget.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerEnd);
    this.canvas.addEventListener('pointercancel', this.onPointerEnd);
    this.canvas.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: true });
  }

  setAction(action, enabled) {
    if (enabled) this.actions.add(action);
    else this.actions.delete(action);
    if (enabled && action === 'jump') this.edges.add('jump');
  }

  setAimToggled(enabled) {
    this.aimToggled = Boolean(enabled);
  }

  sample(deltaTime) {
    const gamepad = this.windowTarget.navigator?.getGamepads?.()
      ?.find((candidate) => candidate?.connected && candidate.mapping === 'standard');
    const axisX = clampAxis(gamepad?.axes?.[0] || 0);
    const axisY = clampAxis(gamepad?.axes?.[1] || 0);
    const lookX = clampAxis(gamepad?.axes?.[2] || 0);
    const lookY = clampAxis(gamepad?.axes?.[3] || 0);
    const buttons = gamepad?.buttons || [];
    const down = (index) => Boolean(buttons[index]?.pressed);

    const mouseLookX = this.mouseLookX;
    const mouseLookY = this.mouseLookY;
    const zoom = this.mouseZoom;
    const edgeActions = new Set(this.edges);
    this.mouseLookX = 0;
    this.mouseLookY = 0;
    this.mouseZoom = 0;
    this.edges.clear();

    const forward = Math.max(-1, Math.min(1,
      Number(this.actions.has('forward')) - Number(this.actions.has('backward')) - axisY));
    const side = Math.max(-1, Math.min(1,
      Number(this.actions.has('right')) - Number(this.actions.has('left')) + axisX));
    const sprint = this.actions.has('sprint') || (buttons[7]?.value || 0) > 0.55;
    const jumpPressed = edgeActions.has('jump') || (down(0) && !this.gamepadJumpPressed);
    this.gamepadJumpPressed = down(0);
    return {
      forward,
      side,
      sprint,
      jumpPressed,
      brake: this.actions.has('jump') || down(1),
      vertical: Number(this.actions.has('up')) - Number(this.actions.has('down')),
      aiming: this.mouseAiming || this.aimToggled || (buttons[6]?.value || 0) > 0.45,
      lookX: mouseLookX,
      lookY: mouseLookY,
      stickX: lookX,
      stickY: lookY,
      zoom,
      lookDeltaTime: deltaTime,
      pressed: this.actions,
      edges: edgeActions
    };
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.windowTarget.removeEventListener('keydown', this.onKeyDown);
    this.windowTarget.removeEventListener('keyup', this.onKeyUp);
    this.windowTarget.removeEventListener('blur', this.onBlur);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerUp);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerEnd);
    this.canvas.removeEventListener('pointercancel', this.onPointerEnd);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.actions.clear();
    this.edges.clear();
    this.mouseDrag = null;
    this.touchLook = null;
  }
}
