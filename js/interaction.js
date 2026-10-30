/* 交互层：缩放、平移、光标、测量
 *
 * 视口就是一对数字：起点和跨度，单位纳秒。所有鼠标动作最终都在改这两个数，
 * 改完喊一声 onUpdate，让上层重绘，自己不碰画布内容。
 */
(function (ns) {
  'use strict';

  const render = ns.render;

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function create(opts) {
    const canvas = opts.canvas;
    const overview = opts.overview;
    const onUpdate = opts.onUpdate;

    const state = {
      timeline: null,
      /* view 是屏幕上正在显示的，targetView 是滚轮想去的地方。
       * 鼠标滚轮一格 deltaY 就是 100~120，一步到位会一格一跳，看着像卡。 */
      view: { t0_ns: 0, span_ns: 1 },
      targetView: { t0_ns: 0, span_ns: 1 },
      isAnimating: false,
      cursor_ns: null,
      marks: [],
      isPanning: false,
      panStartX: 0,
      panStartT0_ns: 0,
      measureAnchor_ns: null,
      overviewDrag: null,
    };

    /* ---------- 视口约束 ---------- */

    function spanLimits() {
      const timeline = state.timeline;
      /* 再小就只看得见一个比特的内部了，留两个比特的视野兜底 */
      const minSpan = Math.max(0.5, timeline.ui_ns * 2);
      const maxSpan = timeline.duration_ns * 1.8;
      return { minSpan, maxSpan };
    }

    function clampView(view) {
      const timeline = state.timeline;
      const { minSpan, maxSpan } = spanLimits();
      const span_ns = clamp(view.span_ns, minSpan, maxSpan);
      const overscan = timeline.duration_ns * 0.12;
      const lo = -overscan;
      const hi = Math.max(lo, timeline.duration_ns + overscan - span_ns);
      return { t0_ns: clamp(view.t0_ns, lo, hi), span_ns };
    }

    /* 画布尺寸只在重排后才会变，没必要每滚一格就去问一次布局。
     * getBoundingClientRect 会强制同步重排——而它前面刚好是读数栏改 DOM，
     * 于是每滚一格就重排一次，滚轮越滚越喘。尺寸交给 ResizeObserver 喂。 */
    let canvasWidth = 0;
    let canvasHeight = 0;
    let cachedLayout = null;

    const resizeWatcher = new ResizeObserver((entries) => {
      const rect = entries[0].contentRect;
      canvasWidth = rect.width;
      canvasHeight = rect.height;
      cachedLayout = null;
    });
    resizeWatcher.observe(canvas);

    function layoutOf() {
      if (!cachedLayout) cachedLayout = render.computeLayout(canvasWidth, canvasHeight);
      return cachedLayout;
    }

    function tOfX(x) {
      const layout = layoutOf();
      return state.view.t0_ns + ((x - layout.plotLeft) / layout.plotWidth) * state.view.span_ns;
    }

    function xOfT(t_ns) {
      const layout = layoutOf();
      return layout.plotLeft + ((t_ns - state.view.t0_ns) / state.view.span_ns) * layout.plotWidth;
    }

    /* ---------- 对外动作 ---------- */

    function setTimeline(timeline) {
      const isFirst = state.timeline === null;
      state.timeline = timeline;
      state.marks = [];
      if (isFirst) fitAll(false);
      else settleView(clampView(state.targetView));
    }

    function fitAll(notify = true) {
      if (!state.timeline) return;
      const dur_ns = state.timeline.duration_ns;
      settleView({ t0_ns: -dur_ns * 0.015, span_ns: dur_ns * 1.03 });
      if (notify) onUpdate();
    }

    /* minSpan_ns 用来给"同步头"这种极短目标兜底，否则按整帧比例留白会退回到看整行的尺度 */
    function focusRange(start_ns, end_ns, notify = true, minSpan_ns = 0, ratio = 1.4) {
      const width_ns = end_ns - start_ns;
      const span_ns = Math.max(width_ns * ratio, spanLimits().minSpan, minSpan_ns);
      const center_ns = (start_ns + end_ns) / 2;
      settleView(clampView({ t0_ns: center_ns - span_ns / 2, span_ns }));
      if (notify) onUpdate();
    }

    /* 跳转目标按包的类型找：整帧、帧起始、某一行、帧间隙、同步头都算一种 */
    function findTargets(key) {
      const timeline = state.timeline;
      if (!timeline) return [];

      if (key === 'frame') {
        return timeline.frames.map((frame) => ({ start_ns: frame.start_ns, end_ns: frame.end_ns }));
      }

      /* 包内部的某一段，首行包当代表 */
      const STAGE_KEYS = ['request', 'prepare', 'zero', 'sync', 'data', 'trail', 'exit'];
      if (STAGE_KEYS.includes(key)) {
        const firstLine = timeline.packets.find((packet) => packet.kind === 'line');
        const stage = firstLine && firstLine.stages.find((item) => item.key === key);
        return stage ? [{ start_ns: stage.start_ns, end_ns: stage.end_ns }] : [];
      }

      return timeline.packets.filter((packet) => packet.kind === key);
    }

    function focusTarget(key, which = 0, notify = true) {
      if (key === 'all' || !state.timeline) {
        fitAll(notify);
        return;
      }

      const targets = findTargets(key);
      if (targets.length === 0) {
        fitAll(notify);
        return;
      }

      const target = which < 0 ? targets[targets.length + which] : targets[which] || targets[0];

      /* 同步头只有几个比特宽，得按比特数而不是按比例撑开视野，不然标不出 0 和 1 */
      const shortKeys = ['sync', 'zero'];
      const minSpan_ns = shortKeys.includes(key) ? state.timeline.ui_ns * 58 : 0;
      /* 一帧要刚好铺满，留白太多会把邻帧的节奏也带进来 */
      focusRange(target.start_ns, target.end_ns, notify, minSpan_ns, key === 'frame' ? 1.04 : 1.4);
    }

    /* ---------- 平滑缩放 ---------- */

    /* 每帧往目标走 32%，十来帧收敛，肉眼看就是滑过去的。
     * 跨度按比例插值（缩放是乘性的），中心按线性插值，光标底下的点才不会漂。 */
    const SMOOTHING = 0.32;

    let rafId = null;

    function stepTowardsView(current, target, k) {
      const span_ns = current.span_ns * Math.pow(target.span_ns / current.span_ns, k);
      const centerNow = current.t0_ns + current.span_ns / 2;
      const centerTarget = target.t0_ns + target.span_ns / 2;
      const center = centerNow + (centerTarget - centerNow) * k;
      return { t0_ns: center - span_ns / 2, span_ns };
    }

    function animateStep() {
      rafId = null;
      if (!state.isAnimating) return;

      const spanRatio = Math.abs(Math.log(state.targetView.span_ns / state.view.span_ns));
      const panRatio = Math.abs(state.targetView.t0_ns - state.view.t0_ns) / state.view.span_ns;

      if (spanRatio < 0.004 && panRatio < 0.004) {
        state.view = { ...state.targetView };
        state.isAnimating = false;
        onUpdate();
        return;
      }

      state.view = stepTowardsView(state.view, state.targetView, SMOOTHING);
      onUpdate();
      rafId = requestAnimationFrame(animateStep);
    }

    function startAnimation() {
      state.isAnimating = true;
      if (rafId === null) rafId = requestAnimationFrame(animateStep);
    }

    function settleView(view) {
      state.isAnimating = false;
      state.view = { ...view };
      state.targetView = { ...view };
    }

    function zoomAt(x, factor, isSmooth) {
      const layout = layoutOf();
      const tAnchor = tOfX(x);
      /* 锚点从目标视口算：动画还没追上时连滚，光标底下才不会漂 */
      const newSpan = state.targetView.span_ns * factor;
      const newT0 = tAnchor - ((x - layout.plotLeft) / layout.plotWidth) * newSpan;
      state.targetView = clampView({ t0_ns: newT0, span_ns: newSpan });

      if (isSmooth) startAnimation();
      else settleView(state.targetView), onUpdate();
    }

    function zoomCenter(factor, isSmooth) {
      zoomAt(canvasWidth * 0.5, factor, isSmooth);
    }

    function panBy_ns(dt_ns) {
      settleView(clampView({ t0_ns: state.view.t0_ns + dt_ns, span_ns: state.view.span_ns }));
      onUpdate();
    }

    function clearMarks() {
      state.marks = [];
      onUpdate();
    }

    /* ---------- 画布事件 ---------- */

    /* offsetX 是浏览器随事件一起算好的，读它不触发任何重排 */
    function localX(event) {
      return event.offsetX;
    }

    /* 缩略图只在长条上找位置，宽度同样交给 ResizeObserver 喂 */
    let overviewWidth = 0;
    const overviewWatcher = new ResizeObserver((entries) => {
      overviewWidth = entries[0].contentRect.width;
    });
    overviewWatcher.observe(overview);

    let wheelPrev_ms = 0;
    let wheelBurst = 1;

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();

        /* 时间跨度从整帧的几十毫秒到单个比特的几百皮秒，跨了六个数量级。
         * 单次滚动保持小步，缩放才跟手；连着滚才慢慢加速，不然要点几十下才挪得动。
         * 加速上限压到 1.6，再高就成了一段一段地跳，看着像卡。 */
        const now_ms = performance.now();
        const isBursting = now_ms - wheelPrev_ms < 160;
        wheelBurst = isBursting ? Math.min(1.6, wheelBurst * 1.12) : 1;
        wheelPrev_ms = now_ms;

        /* 有的浏览器按行给 delta，有的驱动一次给好几百，不收拾会跳过头 */
        const rawDelta = event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
        const delta = Math.max(-160, Math.min(160, rawDelta));

        /* 触控板捏合会被浏览器伪装成按住 ctrl 的滚轮，delta 只有个位数。
         * 用滚轮的系数去乘，捏十下才动 15%，手上一片死区——这就是"缩放卡住"的来源。 */
        const gain = event.ctrlKey ? 0.012 : 0.0019 * wheelBurst;
        zoomAt(localX(event), Math.exp(delta * gain), true);
      },
      { passive: false }
    );

    canvas.addEventListener('pointerdown', (event) => {
      /* 手一按下去就停下正在滑的动画，不然拖拽会跟残余动画抢视口 */
      state.isAnimating = false;
      const x = localX(event);

      if (event.shiftKey) {
        state.measureAnchor_ns = clamp(tOfX(x), 0, state.timeline.duration_ns);
        state.marks = [state.measureAnchor_ns, state.measureAnchor_ns];
      } else {
        state.isPanning = true;
        state.panStartX = x;
        state.panStartT0_ns = state.view.t0_ns;
        canvas.classList.add('is-panning');
      }

      /* 合成事件的 pointerId 可能对不上，抓不住就算了，反正画布内照样收得到 */
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
      onUpdate();
    });

    canvas.addEventListener('pointermove', (event) => {
      const x = localX(event);
      state.cursor_ns = tOfX(x);

      if (state.isPanning) {
        const layout = layoutOf();
        const dx = x - state.panStartX;
        const dt_ns = -(dx / layout.plotWidth) * state.view.span_ns;
        settleView(clampView({ t0_ns: state.panStartT0_ns + dt_ns, span_ns: state.view.span_ns }));
      } else if (state.measureAnchor_ns !== null) {
        state.marks = [state.measureAnchor_ns, clamp(state.cursor_ns, 0, state.timeline.duration_ns)];
      }
      onUpdate();
    });

    function endPointer() {
      state.isPanning = false;
      state.measureAnchor_ns = null;
      canvas.classList.remove('is-panning');
      onUpdate();
    }

    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    canvas.addEventListener('pointerleave', () => {
      if (!state.isPanning && state.measureAnchor_ns === null) {
        state.cursor_ns = null;
        onUpdate();
      }
    });

    canvas.addEventListener('dblclick', () => {
      fitAll();
      clearMarks();
    });

    canvas.addEventListener('keydown', (event) => {
      const step = state.view.span_ns * 0.12;
      if (event.key === 'ArrowLeft') {
        panBy_ns(-step);
      } else if (event.key === 'ArrowRight') {
        panBy_ns(step);
      } else if (event.key === 'ArrowUp' || event.key === '+') {
        zoomCenter(1 / 1.35, true);
      } else if (event.key === 'ArrowDown' || event.key === '-') {
        zoomCenter(1.35, true);
      } else if (event.key === '0') {
        fitAll();
      } else {
        return;
      }
      event.preventDefault();
    });

    /* ---------- 缩略图事件 ---------- */

    function overviewTimeAt(event) {
      const rel = (event.offsetX - 2) / Math.max(1, overviewWidth - 4);
      return clamp(rel, 0, 1) * state.timeline.duration_ns;
    }

    overview.addEventListener('pointerdown', (event) => {
      if (!state.timeline) return;
      try {
        overview.setPointerCapture(event.pointerId);
      } catch {
        /* 忽略 */
      }
      const t_ns = overviewTimeAt(event);
      const { t0_ns, span_ns } = state.view;
      const isInside = t_ns >= t0_ns && t_ns <= t0_ns + span_ns;

      state.overviewDrag = {
        startX: event.clientX,
        startT0_ns: t0_ns,
        isInside,
        grabOffset_ns: isInside ? t_ns - t0_ns : span_ns / 2,
      };

      if (!isInside) {
        settleView(clampView({ t0_ns: t_ns - span_ns / 2, span_ns }));
      }
      onUpdate();
    });

    overview.addEventListener('pointermove', (event) => {
      const drag = state.overviewDrag;
      if (!drag) return;
      const pxPer_ns = (overviewWidth - 4) / state.timeline.duration_ns;
      const dx = event.clientX - drag.startX;
      const t0_ns = drag.isInside
        ? drag.startT0_ns + dx / pxPer_ns
        : overviewTimeAt(event) - drag.grabOffset_ns;
      settleView(clampView({ t0_ns, span_ns: state.view.span_ns }));
      onUpdate();
    });

    function endOverviewDrag() {
      state.overviewDrag = null;
    }
    overview.addEventListener('pointerup', endOverviewDrag);
    overview.addEventListener('pointercancel', endOverviewDrag);

    return {
      setTimeline,
      fitAll,
      focusRange,
      focusTarget,
      zoomAt,
      zoomCenter,
      panBy_ns,
      clearMarks,
      getView: () => ({ ...state.view }),
      getCursor_ns: () => state.cursor_ns,
      getMarks: () => state.marks.slice(),
      getTimeline: () => state.timeline,
      setViewSpan: (span_ns) => {
        settleView(clampView({ ...state.view, span_ns }));
        onUpdate();
      },
    };
  }

  ns.interaction = { create };
})(window.MIPI = window.MIPI || {});
