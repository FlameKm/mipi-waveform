/* 装配层
 *
 * 把参数面板、时间线、交互和绘制串起来，只做依赖装配和事件转发，不掺业务计算。
 */
(function (ns) {
  'use strict';

  const model = ns.model;
  const render = ns.render;

  const dom = {
    scope: document.getElementById('scope'),
    overview: document.getElementById('overview'),
    selRate: document.getElementById('sel-rate'),
    selFrames: document.getElementById('sel-frames'),
    selLines: document.getElementById('sel-lines'),
    selPayload: document.getElementById('sel-payload'),
    selVblank: document.getElementById('sel-vblank'),
    chkEscape: document.getElementById('chk-escape'),
    btnReset: document.getElementById('btn-reset'),
    jumpbar: document.getElementById('jumpbar'),
    roTime: document.getElementById('ro-time'),
    roState: document.getElementById('ro-state'),
    roDp: document.getElementById('ro-dp'),
    roDn: document.getElementById('ro-dn'),
    roDiff: document.getElementById('ro-diff'),
    roMeasure: document.getElementById('ro-measure'),
    roTimebase: document.getElementById('ro-timebase'),
    roWhere: document.getElementById('ro-where'),
  };

  const params = {
    rate_bps: 1e9,
    frameCount: 3,
    linesPerFrame: 4,
    payloadLen_bytes: 64,
    vblankKey: 'normal',
    isEscaping: false,
    seed: 1,
  };

  let timeline = null;
  let isDrawQueued = false;

  /* ---------- 画布与像素比 ---------- */

  function prepareCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const pixelWidth = Math.round(width * dpr);
    const pixelHeight = Math.round(height * dpr);

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, width, height };
  }

  /* ---------- 绘制调度 ---------- */

  function requestDraw() {
    if (isDrawQueued) return;
    isDrawQueued = true;
    requestAnimationFrame(() => {
      isDrawQueued = false;
      draw();
    });
  }

  function draw() {
    const scope = prepareCanvas(dom.scope);
    const scopeResult = render.drawScope(scope.ctx, {
      width: scope.width,
      height: scope.height,
      timeline,
      view: interaction.getView(),
      cursor_ns: interaction.getCursor_ns(),
      marks: interaction.getMarks(),
    });

    const overview = prepareCanvas(dom.overview);
    render.drawOverview(overview.ctx, {
      width: overview.width,
      height: overview.height,
      timeline,
      view: interaction.getView(),
    });

    updateReadout(scopeResult.step_ns);
  }

  /* ---------- 读数 ---------- */

  function updateReadout(step_ns) {
    const view = interaction.getView();
    const cursor_ns = interaction.getCursor_ns();
    const isInside =
      cursor_ns !== null &&
      cursor_ns >= Math.max(0, view.t0_ns) &&
      cursor_ns <= Math.min(timeline.duration_ns, view.t0_ns + view.span_ns);
    const info = isInside ? model.describeAt(timeline, cursor_ns) : null;

    if (!info) {
      dom.roTime.textContent = '—';
      dom.roWhere.textContent = '—';
      dom.roWhere.classList.add('is-muted');
      dom.roState.textContent = '把鼠标移到波形上';
      dom.roState.classList.add('is-muted');
      dom.roDp.textContent = '—';
      dom.roDn.textContent = '—';
      dom.roDiff.textContent = '—';
    } else {
      dom.roTime.textContent = model.formatTime_ns(cursor_ns);
      dom.roWhere.textContent = info.where || '空闲';
      dom.roWhere.classList.toggle('is-muted', !info.where);
      dom.roState.textContent = info.detail ? `${info.title} · ${info.detail}` : info.title;
      dom.roState.classList.remove('is-muted');
      dom.roDp.textContent = model.formatVoltage_v(info.dp_v);
      dom.roDn.textContent = model.formatVoltage_v(info.dn_v);
      dom.roDiff.textContent = model.formatVoltage_v(info.dp_v - info.dn_v);
    }

    dom.roTimebase.textContent = `每格 ${model.formatTime_ns(step_ns)}`;

    const marks = interaction.getMarks();
    if (marks.length === 2) {
      const delta_ns = Math.abs(marks[1] - marks[0]);
      const uiCount = delta_ns / timeline.ui_ns;
      dom.roMeasure.textContent =
        `${model.formatTime_ns(delta_ns)}　=　${uiCount < 10 ? uiCount.toFixed(2) : uiCount.toFixed(1)} 个比特时间`;
      dom.roMeasure.classList.remove('is-muted');
    } else {
      dom.roMeasure.textContent = '按住 Shift 拖一下，量任意两点的间隔';
      dom.roMeasure.classList.add('is-muted');
    }
  }

  /* ---------- 参数面板 ---------- */

  function fillSelect(select, values, format, valueOf) {
    select.replaceChildren();
    for (const value of values) {
      const option = document.createElement('option');
      option.value = String(valueOf ? valueOf(value) : value);
      option.textContent = format(value);
      select.appendChild(option);
    }
  }

  const formatRate = (bps) => (bps >= 1e9 ? `${bps / 1e9} Gbps` : `${bps / 1e6} Mbps`);

  function syncParamInputs() {
    dom.selRate.value = String(params.rate_bps);
    dom.selFrames.value = String(params.frameCount);
    dom.selLines.value = String(params.linesPerFrame);
    dom.selPayload.value = String(params.payloadLen_bytes);
    dom.selVblank.value = params.vblankKey;
    dom.chkEscape.checked = params.isEscaping;

    for (const button of dom.jumpbar.querySelectorAll('[data-focus="escape"]')) {
      button.disabled = !params.isEscaping;
    }
  }

  function rebuild() {
    timeline = model.build(params);
    interaction.setTimeline(timeline);
    /* 速率和载荷一改，整条时间线的尺度全变了，停在旧视口只会看到空白 */
    interaction.fitAll(false);
    syncParamInputs();
    requestDraw();
  }

  /* ---------- 跳转 ---------- */

  function focusKey(key, which = 0) {
    if (key === 'escape' && !params.isEscaping) {
      params.isEscaping = true;
      rebuild();
    }
    interaction.focusTarget(key, which);
  }

  function bindJumpButtons() {
    const buttons = [
      ...dom.jumpbar.querySelectorAll('button[data-focus]'),
      ...document.querySelectorAll('.chapter[data-focus]'),
    ];

    for (const button of buttons) {
      const key = button.dataset.focus;
      const which = Number(button.dataset.which || 0);
      button.addEventListener('click', () => {
        focusKey(key, which);
        dom.scope.scrollIntoView({ behavior: 'smooth', block: 'center' });
        dom.scope.focus({ preventScroll: true });
      });
    }
  }

  /* ---------- 启动 ---------- */

  fillSelect(dom.selRate, model.RATE_CHOICES_BPS, formatRate);
  fillSelect(dom.selFrames, model.FRAME_CHOICES, (n) => `${n} 帧`);
  fillSelect(dom.selLines, model.LINES_CHOICES, (n) => `${n} 行`);
  fillSelect(dom.selPayload, model.PAYLOAD_CHOICES_BYTES, (n) => `${n} 字节`);
  fillSelect(dom.selVblank, model.VBLANK_CHOICES, (c) => c.label, (c) => c.key);

  dom.selRate.addEventListener('change', (event) => {
    params.rate_bps = Number(event.target.value);
    rebuild();
  });
  dom.selFrames.addEventListener('change', (event) => {
    params.frameCount = Number(event.target.value);
    rebuild();
  });
  dom.selLines.addEventListener('change', (event) => {
    params.linesPerFrame = Number(event.target.value);
    rebuild();
  });
  dom.selPayload.addEventListener('change', (event) => {
    params.payloadLen_bytes = Number(event.target.value);
    params.seed = (params.seed + 7) % 100000;
    rebuild();
  });
  dom.selVblank.addEventListener('change', (event) => {
    params.vblankKey = event.target.value;
    rebuild();
  });
  dom.chkEscape.addEventListener('change', (event) => {
    params.isEscaping = event.target.checked;
    rebuild();
  });

  dom.scope.tabIndex = 0;

  const interaction = ns.interaction.create({
    canvas: dom.scope,
    overview: dom.overview,
    onUpdate: requestDraw,
  });

  dom.btnReset.addEventListener('click', () => {
    interaction.fitAll();
    interaction.clearMarks();
  });

  rebuild();
  bindJumpButtons();

  const resizeObserver = new ResizeObserver(requestDraw);
  resizeObserver.observe(dom.scope);
  resizeObserver.observe(dom.overview);

  window.addEventListener('resize', requestDraw);
  requestDraw();
})(window.MIPI = window.MIPI || {});
