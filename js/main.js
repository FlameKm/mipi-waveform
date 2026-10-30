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
    selResolution: document.getElementById('sel-resolution'),
    selFormat: document.getElementById('sel-format'),
    selLanes: document.getElementById('sel-lanes'),
    selClock: document.getElementById('sel-clock'),
    inpHBlank: document.getElementById('inp-hblank'),
    inpVBlank: document.getElementById('inp-vblank'),
    selFrames: document.getElementById('sel-frames'),
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
    bdFps: document.getElementById('bd-fps'),
    bdBytes: document.getElementById('bd-bytes'),
    bdActive: document.getElementById('bd-active'),
    bdLine: document.getElementById('bd-line'),
    bdFrame: document.getElementById('bd-frame'),
    bdDuty: document.getElementById('bd-duty'),
    bdLink: document.getElementById('bd-link'),
  };

  /* 默认为 720p30 量级的真实配置：4 lane、每条 100 Mbps，链路刚够用 */
  const params = {
    clockLane_mhz: 50,
    laneCount: 4,
    formatKey: 'RAW10',
    width_px: 1280,
    height_px: 720,
    hblank_px: 200,
    vblank_lines: 40,
    frameCount: 3,
    isEscaping: false,
    seed: 1,
  };

  let timeline = null;
  let isDrawQueued = false;

  /* ---------- 画布与像素比 ---------- */

  /* 尺寸由 ResizeObserver 报上来，别每帧去问布局——问一次就可能强制同步重排一次 */
  const canvasSize = new WeakMap();

  function prepareCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    let size = canvasSize.get(canvas);
    if (!size) {
      const rect = canvas.getBoundingClientRect();
      size = { width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
      canvasSize.set(canvas, size);
    }

    const width = size.width;
    const height = size.height;
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

  /* 每帧都要刷一遍读数，内容没变就别碰 DOM，省下不必要的样式重算 */
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }

  function setMuted(el, isMuted) {
    el.classList.toggle('is-muted', isMuted);
  }

  function updateReadout(step_ns) {
    const view = interaction.getView();
    const cursor_ns = interaction.getCursor_ns();
    const isInside =
      cursor_ns !== null &&
      cursor_ns >= Math.max(0, view.t0_ns) &&
      cursor_ns <= Math.min(timeline.duration_ns, view.t0_ns + view.span_ns);
    const info = isInside ? model.describeAt(timeline, cursor_ns) : null;

    if (!info) {
      setText(dom.roTime, '—');
      setText(dom.roWhere, '—');
      setMuted(dom.roWhere, true);
      setText(dom.roState, '把鼠标移到波形上');
      setMuted(dom.roState, true);
      setText(dom.roDp, '—');
      setText(dom.roDn, '—');
      setText(dom.roDiff, '—');
    } else {
      setText(dom.roTime, model.formatTime_ns(cursor_ns));
      setText(dom.roWhere, info.where || '空闲');
      setMuted(dom.roWhere, !info.where);
      setText(dom.roState, info.detail ? `${info.title} · ${info.detail}` : info.title);
      setMuted(dom.roState, false);
      setText(dom.roDp, model.formatVoltage_v(info.dp_v));
      setText(dom.roDn, model.formatVoltage_v(info.dn_v));
      setText(dom.roDiff, model.formatVoltage_v(info.dp_v - info.dn_v));
    }

    setText(dom.roTimebase, `每格 ${model.formatTime_ns(step_ns)}`);

    const marks = interaction.getMarks();
    if (marks.length === 2) {
      const delta_ns = Math.abs(marks[1] - marks[0]);
      const uiCount = delta_ns / timeline.ui_ns;
      setText(
        dom.roMeasure,
        `${model.formatTime_ns(delta_ns)}　=　${uiCount < 10 ? uiCount.toFixed(2) : uiCount.toFixed(1)} 个比特时间`
      );
      setMuted(dom.roMeasure, false);
    } else {
      setText(dom.roMeasure, '按住 Shift 拖一下，量任意两点的间隔');
      setMuted(dom.roMeasure, true);
    }
  }

  /* ---------- 带宽预算 ---------- */

  function formatBytes(bytes) {
    return bytes >= 1024 ? `${(bytes / 1024).toFixed(2)} KB` : `${bytes} B`;
  }


  function formatBandwidth(bps) {
    if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} Gbps`;
    return `${Math.round(bps / 1e6)} Mbps`;
  }

  function updateBudget() {
    const t = timeline;
    dom.bdFps.textContent = `${t.fps.toFixed(1)} fps`;
    dom.bdBytes.textContent = `${formatBytes(t.lineBytes_bytes)} · ${t.perLaneBytes_bytes} B`;
    dom.bdActive.textContent = model.formatTime_ns(t.lineActive_ns);
    dom.bdLine.textContent = model.formatTime_ns(t.linePeriod_ns);
    dom.bdFrame.textContent = model.formatTime_ns(t.framePeriod_ns);
    dom.bdDuty.textContent = `${t.dutyPercent.toFixed(1)}%`;
    dom.bdLink.textContent = `${formatBandwidth(t.bitRate_bps)} × ${t.laneCount}`;
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

  const resolutionKeyOf = (p) => `${p.width_px}x${p.height_px}`;
  const findResolution = (key) => model.RESOLUTIONS.find((r) => r.key === key) || model.RESOLUTIONS[3];

  function syncParamInputs() {
    dom.selResolution.value = resolutionKeyOf(params);
    dom.selFormat.value = params.formatKey;
    dom.selLanes.value = String(params.laneCount);
    dom.selClock.value = String(params.clockLane_mhz);
    dom.inpHBlank.value = String(params.hblank_px);
    dom.inpVBlank.value = String(params.vblank_lines);
    dom.selFrames.value = String(params.frameCount);
    dom.chkEscape.checked = params.isEscaping;

    for (const button of dom.jumpbar.querySelectorAll('[data-focus="escape"]')) {
      button.disabled = !params.isEscaping;
    }
  }

  function rebuild() {
    timeline = model.build(params);
    interaction.setTimeline(timeline);
    /* 参数一改，整条时间线的尺度全变了，停在旧视口只会看到空白。
     * 但直接铺全程也不合适：一帧七百多行压进一千像素就是一块实心，
     * 所以先落在开头十行上，看得见包的结构，要看帧的节奏点上面的按钮。 */
    interaction.focusRange(0, Math.min(timeline.duration_ns, timeline.linePeriod_ns * 10), false);
    syncParamInputs();
    updateBudget();
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

  fillSelect(dom.selResolution, model.RESOLUTIONS, (r) => `${r.width_px}×${r.height_px}`, (r) => r.key);
  fillSelect(dom.selFormat, model.FORMATS, (f) => `${f.label}（${f.bitsPerPixel} bit/像素）`, (f) => f.key);
  fillSelect(dom.selLanes, model.LANE_CHOICES, (n) => `${n} 条`);
  fillSelect(dom.selClock, model.CLOCK_LANE_CHOICES_MHZ, (mhz) => `${mhz} MHz`);
  fillSelect(dom.selFrames, model.FRAME_CHOICES, (n) => `${n} 帧`);

  dom.selResolution.addEventListener('change', (event) => {
    const preset = findResolution(event.target.value);
    params.width_px = preset.width_px;
    params.height_px = preset.height_px;
    /* 每档分辨率的消隐典型值差得远，切过去就一起换掉 */
    params.hblank_px = preset.hblank_px;
    params.vblank_lines = preset.vblank_lines;
    rebuild();
  });

  dom.selFormat.addEventListener('change', (event) => {
    params.formatKey = event.target.value;
    params.seed = (params.seed + 7) % 100000;
    rebuild();
  });

  dom.selLanes.addEventListener('change', (event) => {
    params.laneCount = Number(event.target.value);
    rebuild();
  });

  dom.selClock.addEventListener('change', (event) => {
    params.clockLane_mhz = Number(event.target.value);
    rebuild();
  });

  /* 数字框用 change 而不是 input，否则每敲一位就重铺一遍几万段的时间线 */
  dom.inpHBlank.addEventListener('change', (event) => {
    params.hblank_px = Math.max(0, Number(event.target.value) || 0);
    rebuild();
  });

  dom.inpVBlank.addEventListener('change', (event) => {
    params.vblank_lines = Math.max(2, Number(event.target.value) || 2);
    rebuild();
  });

  dom.selFrames.addEventListener('change', (event) => {
    params.frameCount = Number(event.target.value);
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

  const resizeObserver = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const rect = entry.contentRect;
      canvasSize.set(entry.target, {
        width: Math.max(1, Math.round(rect.width)),
        height: Math.max(1, Math.round(rect.height)),
      });
    }
    requestDraw();
  });
  resizeObserver.observe(dom.scope);
  resizeObserver.observe(dom.overview);

  window.addEventListener('resize', requestDraw);
  requestDraw();
})(window.MIPI = window.MIPI || {});
