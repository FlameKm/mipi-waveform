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
      view: { t0_ns: 0, span_ns: 1 },
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

    function layoutOf() {
      const rect = canvas.getBoundingClientRect();
      return { rect, layout: render.computeLayout(rect.width, rect.height) };
    }

    function tOfX(x) {
      const { layout } = layoutOf();
      return state.view.t0_ns + ((x - layout.plotLeft) / layout.plotWidth) * state.view.span_ns;
    }

    function xOfT(t_ns) {
      const { layout } = layoutOf();
      return layout.plotLeft + ((t_ns - state.view.t0_ns) / state.view.span_ns) * layout.plotWidth;
    }

    /* ---------- 对外动作 ---------- */

    function setTimeline(timeline) {
      const isFirst = state.timeline === null;
      state.timeline = timeline;
      state.marks = [];
      if (isFirst) fitAll(false);
      else state.view = clampView(state.view);
    }

    function fitAll(notify = true) {
      if (!state.timeline) return;
      const dur_ns = state.timeline.duration_ns;
      state.view = { t0_ns: -dur_ns * 0.015, span_ns: dur_ns * 1.03 };
      if (notify) onUpdate();
    }

    /* minSpan_ns 用来给"同步头"这种极短目标兜底，否则按整帧比例留白会退回到看整行的尺度 */
    function focusRange(start_ns, end_ns, notify = true, minSpan_ns = 0, ratio = 1.4) {
      const width_ns = end_ns - start_ns;
      const span_ns = Math.max(width_ns * ratio, spanLimits().minSpan, minSpan_ns);
      const center_ns = (start_ns + end_ns) / 2;
      state.view = clampView({ t0_ns: center_ns - span_ns / 2, span_ns });
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

    function zoomAt(x, factor) {
      const { layout } = layoutOf();
      const tAnchor = tOfX(x);
      const newSpan = state.view.span_ns * factor;
      const newT0 = tAnchor - ((x - layout.plotLeft) / layout.plotWidth) * newSpan;
      state.view = clampView({ t0_ns: newT0, span_ns: newSpan });
      onUpdate();
    }

    function zoomCenter(factor) {
      const rect = canvas.getBoundingClientRect();
      zoomAt(rect.width * 0.5, factor);
    }

    function panBy_ns(dt_ns) {
      state.view = clampView({ t0_ns: state.view.t0_ns + dt_ns, span_ns: state.view.span_ns });
      onUpdate();
    }

    function clearMarks() {
      state.marks = [];
      onUpdate();
    }

    /* ---------- 画布事件 ---------- */

    function localX(event) {
      return event.clientX - canvas.getBoundingClientRect().left;
    }

    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();

        /* 时间跨度从整帧的几十毫秒到单个比特的几百皮秒，跨了六个数量级。
         * 单次滚动放小步保证精度，连着滚就自动加速，不然要点几十下才挪得动。 */
        const now_ms = performance.now();
        wheelBurst = now_ms - wheelPrev_ms < 140 ? Math.min(2.4, wheelBurst * 1.2) : 1;
        wheelPrev_ms = now_ms;

        const factor = Math.exp(event.deltaY * 0.0021 * wheelBurst);
        zoomAt(localX(event), factor);
      },
      { passive: false }
    );

    let wheelPrev_ms = 0;
    let wheelBurst = 1;

    canvas.addEventListener('pointerdown', (event) => {
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
        const { layout } = layoutOf();
        const dx = x - state.panStartX;
        const dt_ns = -(dx / layout.plotWidth) * state.view.span_ns;
        state.view = clampView({ t0_ns: state.panStartT0_ns + dt_ns, span_ns: state.view.span_ns });
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
        zoomCenter(1 / 1.35);
      } else if (event.key === 'ArrowDown' || event.key === '-') {
        zoomCenter(1.35);
      } else if (event.key === '0') {
        fitAll();
      } else {
        return;
      }
      event.preventDefault();
    });

    /* ---------- 缩略图事件 ---------- */

    function overviewTimeAt(event) {
      const rect = overview.getBoundingClientRect();
      const rel = (event.clientX - rect.left - 2) / Math.max(1, rect.width - 4);
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
        state.view = clampView({ t0_ns: t_ns - span_ns / 2, span_ns });
      }
      onUpdate();
    });

    overview.addEventListener('pointermove', (event) => {
      const drag = state.overviewDrag;
      if (!drag) return;
      const rect = overview.getBoundingClientRect();
      const pxPer_ns = (rect.width - 4) / state.timeline.duration_ns;
      const dx = event.clientX - drag.startX;
      const t0_ns = drag.isInside
        ? drag.startT0_ns + dx / pxPer_ns
        : overviewTimeAt(event) - drag.grabOffset_ns;
      state.view = clampView({ t0_ns, span_ns: state.view.span_ns });
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
        state.view = clampView({ ...state.view, span_ns });
        onUpdate();
      },
    };
  }

  ns.interaction = { create };
})(window.MIPI = window.MIPI || {});
