/* 波形绘制层
 *
 * 只吃时间线、视口和光标位置，不碰任何 DOM 状态。
 * 上半部分是状态色带和字段条，中间三个通道各自独立量程，底部是时间轴。
 */
(function (ns) {
  'use strict';

  const model = ns.model;

  const CHANNELS = [
    {
      key: 'dp',
      label: 'Dp',
      unit: 'V',
      min_v: -0.14,
      max_v: 1.34,
      ticks_v: [0, 0.6, 1.2],
      color: '#2563eb',
      pickLp: (seg) => seg.dp_v,
      pickBit: (bit) => model.HS_LEVEL[bit].dp_v,
    },
    {
      key: 'dn',
      label: 'Dn',
      unit: 'V',
      min_v: -0.14,
      max_v: 1.34,
      ticks_v: [0, 0.6, 1.2],
      color: '#e2571f',
      pickLp: (seg) => seg.dn_v,
      pickBit: (bit) => model.HS_LEVEL[bit].dn_v,
    },
    {
      key: 'diff',
      label: 'Dp − Dn',
      unit: 'mV',
      min_v: -0.46,
      max_v: 0.46,
      ticks_v: [-0.2, 0, 0.2],
      color: '#0f9d58',
      isDiff: true,
      pickLp: (seg) => seg.dp_v - seg.dn_v,
      pickBit: (bit) => model.HS_LEVEL[bit].dp_v - model.HS_LEVEL[bit].dn_v,
    },
  ];

  const LAYOUT = {
    gutter: 58,
    ribbonTop: 10,
    ribbonHeight: 24,
    fieldTop: 38,
    fieldHeight: 15,
    plotTop: 60,
    axisHeight: 34,
    rightPad: 14,
    channelGap: 17,
  };

  function computeLayout(width, height) {
    const plotLeft = LAYOUT.gutter;
    const plotWidth = Math.max(40, width - LAYOUT.gutter - LAYOUT.rightPad);
    const plotTop = LAYOUT.plotTop;
    const plotBottom = height - LAYOUT.axisHeight;
    const gap = LAYOUT.channelGap;
    const usable = plotBottom - plotTop - gap * CHANNELS.length;
    const channelHeight = usable / CHANNELS.length;

    /* 每个通道上方空出一条缝给名字，避免它和顶部的电平刻度撞在同一个位置 */
    const channelBoxes = CHANNELS.map((channel, i) => ({
      channel,
      top: plotTop + gap + i * (channelHeight + gap),
      height: channelHeight,
    }));

    return {
      width,
      height,
      plotLeft,
      plotWidth,
      plotRight: plotLeft + plotWidth,
      plotTop,
      plotBottom,
      axisTop: plotBottom,
      ribbonTop: LAYOUT.ribbonTop,
      ribbonHeight: LAYOUT.ribbonHeight,
      fieldTop: LAYOUT.fieldTop,
      fieldHeight: LAYOUT.fieldHeight,
      channelBoxes,
    };
  }

  /* 网格步长只在这里算一次，时间轴和读数区共用，免得两边说法对不上 */
  function timeStep_nsFor(plotWidth_px, span_ns) {
    /* 窄屏格子本来就少，间距收紧一点，不然全程只剩两个刻度 */
    const minTickSpacing_px = plotWidth_px < 520 ? 66 : 104;
    const targetCount = Math.max(3, Math.floor(plotWidth_px / minTickSpacing_px));
    return model.tickStep_ns(span_ns, targetCount);
  }

  function makeScale(layout, view) {
    const xOf_ns = (t_ns) => layout.plotLeft + ((t_ns - view.t0_ns) / view.span_ns) * layout.plotWidth;
    const tOf_x = (x) => view.t0_ns + ((x - layout.plotLeft) / layout.plotWidth) * view.span_ns;
    const pxPer_ns = layout.plotWidth / view.span_ns;
    return { xOf_ns, tOf_x, pxPer_ns };
  }

  /* roundRect 在旧浏览器上不一定有，自己画一个省得操心 */
  function roundedRectPath(ctx, x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  function yOf_v(box, v) {
    const pad = 6;
    const inner = box.height - pad * 2;
    const norm = (v - box.channel.min_v) / (box.channel.max_v - box.channel.min_v);
    return box.top + pad + (1 - norm) * inner;
  }

  /* ---------- 背景与网格 ---------- */

  function drawBackground(ctx, layout) {
    ctx.fillStyle = '#fcfdfe';
    ctx.fillRect(0, 0, layout.width, layout.height);
  }

  function drawGrid(ctx, layout, scale, view) {
    const step_ns = timeStep_nsFor(layout.plotWidth, view.span_ns);
    const first = Math.ceil(view.t0_ns / step_ns) * step_ns;

    ctx.save();
    ctx.strokeStyle = '#eef1f6';
    ctx.lineWidth = 1;

    for (let t = first; t <= view.t0_ns + view.span_ns; t += step_ns) {
      const x = Math.round(scale.xOf_ns(t)) + 0.5;
      if (x < layout.plotLeft || x > layout.plotRight) continue;
      ctx.beginPath();
      ctx.moveTo(x, layout.plotTop - 4);
      ctx.lineTo(x, layout.plotBottom);
      ctx.stroke();
    }

    for (const box of layout.channelBoxes) {
      for (const v of box.channel.ticks_v) {
        const y = Math.round(yOf_v(box, v)) + 0.5;
        ctx.strokeStyle = v === 0 ? '#dfe5ee' : '#f2f5f9';
        ctx.beginPath();
        ctx.moveTo(layout.plotLeft, y);
        ctx.lineTo(layout.plotRight, y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* ---------- 通道框与刻度 ---------- */

  function drawChannelFrames(ctx, layout) {
    for (const box of layout.channelBoxes) {
      ctx.save();
      ctx.strokeStyle = '#e9edf3';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        Math.round(layout.plotLeft) + 0.5,
        Math.round(box.top) + 0.5,
        Math.round(layout.plotWidth) - 1,
        Math.round(box.height) - 1
      );

      const labelY = box.top - 9;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
      ctx.fillStyle = box.channel.color;
      ctx.fillText(box.channel.label, 9, labelY);

      const labelWidth = ctx.measureText(box.channel.label).width;
      ctx.font = '9px system-ui, -apple-system, "PingFang SC", sans-serif';
      ctx.fillStyle = '#a8b2c1';
      ctx.fillText(box.channel.unit, 9 + labelWidth + 5, labelY + 0.5);

      for (const v of box.channel.ticks_v) {
        const y = yOf_v(box, v);
        ctx.fillStyle = '#9aa5b5';
        ctx.font = '9.5px ui-monospace, Menlo, Consolas, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        const text = box.channel.isDiff ? `${Math.round(v * 1000)}` : v.toFixed(1).replace('.0', '');
        ctx.fillText(text, layout.plotLeft - 10, y);
      }

      ctx.restore();
    }
  }

  /* ---------- 状态色带 ---------- */

  /* 全局看是"帧起始 / 行 / 帧间隙"，放大到单个包才展开成握手、同步、数据这些阶段 */
  const STAGE_EXPAND_MIN_PX = 190;

  function drawPhaseRibbon(ctx, layout, timeline, scale, view) {
    const top = layout.ribbonTop;
    const height = layout.ribbonHeight;

    for (const item of model.packetsIn(timeline, view.t0_ns, view.t0_ns + view.span_ns)) {
      const x0 = Math.max(layout.plotLeft, scale.xOf_ns(item.start_ns));
      const x1 = Math.min(layout.plotRight, scale.xOf_ns(item.end_ns));
      const w = x1 - x0;
      if (w < 1) continue;

      if (item.stages && w > STAGE_EXPAND_MIN_PX) {
        for (const stage of item.stages) {
          const sx0 = Math.max(layout.plotLeft, scale.xOf_ns(stage.start_ns));
          const sx1 = Math.min(layout.plotRight, scale.xOf_ns(stage.end_ns));
          const stageStyle = model.STAGE_STYLE[stage.key];
          paintRibbonBlock(ctx, sx0, sx1, top, height, stageStyle, stageStyle && stageStyle.name);
        }
        continue;
      }

      paintRibbonBlock(ctx, x0, x1, top, height, model.PACKET_STYLE[item.kind], item.label, w);
    }

    ctx.save();
    ctx.strokeStyle = '#e3e8ef';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.plotLeft, top + height + 0.5);
    ctx.lineTo(layout.plotRight, top + height + 0.5);
    ctx.stroke();
    ctx.restore();
  }

  function paintRibbonBlock(ctx, x0, x1, top, height, style, label, totalWidth) {
    const w = x1 - x0;
    if (w < 0.5 || !style) return;

    ctx.save();
    ctx.globalAlpha = 0.14;
    ctx.fillStyle = style.color;
    ctx.fillRect(x0, top, w, height);
    ctx.restore();

    ctx.fillStyle = style.color;
    ctx.fillRect(x0, top, 1.5, height);

    if (label && w > 42) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 4, top, Math.max(0, w - 6), height);
      ctx.clip();
      ctx.fillStyle = style.color;
      ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x0 + 6, top + height / 2 + 0.5);
      ctx.restore();
    }
  }

  /* ---------- 字段条 ---------- */

  const FIELD_COLORS = ['#2563eb', '#7c3aed', '#0891b2', '#0f9d58', '#e2571f'];
  const FIELD_MIN_PACKET_PX = 150;

  function drawFieldBar(ctx, layout, timeline, scale, view) {
    const top = layout.fieldTop;

    for (const packet of model.packetsIn(timeline, view.t0_ns, view.t0_ns + view.span_ns)) {
      if (!packet.fields) continue;

      /* 一屏里有几十个包时，每个包都标字段只会糊成一片 */
      const packetWidth = scale.xOf_ns(packet.end_ns) - scale.xOf_ns(packet.start_ns);
      if (packetWidth < FIELD_MIN_PACKET_PX) continue;

      let lastRight = -Infinity;

      packet.fields.forEach((field, i) => {
        const x0 = scale.xOf_ns(field.start_ns);
        const x1 = scale.xOf_ns(field.end_ns);
        if (x1 < layout.plotLeft || x0 > layout.plotRight) return;

        const left = Math.max(layout.plotLeft, x0);
        const right = Math.min(layout.plotRight, x1);
        const w = right - left;
        if (w < 2) return;

        const color = FIELD_COLORS[i % FIELD_COLORS.length];

        ctx.save();
        ctx.globalAlpha = 0.1;
        ctx.fillStyle = color;
        ctx.fillRect(left, top, w, layout.fieldHeight);
        ctx.restore();

        ctx.fillStyle = color;
        ctx.fillRect(left, top, 1, layout.fieldHeight);

        const textX = Math.max(left + 5, lastRight + 8);
        if (right - textX > 34) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, top - 2, w, layout.fieldHeight + 4);
          ctx.clip();
          ctx.fillStyle = color;
          ctx.font = '11px system-ui, -apple-system, "PingFang SC", sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(field.name, textX, top + layout.fieldHeight / 2 + 0.5);
          ctx.restore();
          lastRight = textX + ctx.measureText(field.name).width;
        }
      });
    }
  }

  function drawFrameMarkers(ctx, layout, timeline, scale, view) {
    const top = layout.fieldTop;
    const height = layout.fieldHeight;

    ctx.save();
    ctx.font = '10.5px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const frame of timeline.frames) {
      const left = Math.max(layout.plotLeft, scale.xOf_ns(frame.start_ns));
      const right = Math.min(layout.plotRight, scale.xOf_ns(frame.end_ns));
      if (right - left < 52) continue;

      ctx.fillStyle = 'rgba(22, 32, 44, 0.05)';
      ctx.fillRect(left + 1, top, right - left - 2, height);

      ctx.fillStyle = '#7b8798';
      ctx.fillText(`帧 ${frame.index + 1}`, (left + right) / 2, top + height / 2 + 0.5);
    }
    ctx.restore();
  }

  /* ---------- 波形 ---------- */

  /* 放大到每个比特都站得住脚时，逐比特画方波 */
  function drawDetailedTrace(ctx, layout, box, timeline, scale, view) {
    const { min_v, max_v } = box.channel;
    const channels = box.channel;
    const intervals = [];
    let hasClipped = false;

    for (const seg of model.segmentsIn(timeline, view.t0_ns, view.t0_ns + view.span_ns)) {
      if (seg.kind === 'lp') {
        intervals.push({ start_ns: seg.start_ns, end_ns: seg.end_ns, v: channels.pickLp(seg) });
        continue;
      }
      const step = seg.ui_ns;
      const first = Math.max(0, Math.floor((view.t0_ns - seg.start_ns) / step));
      const last = Math.min(seg.bits.length, Math.ceil((view.t0_ns + view.span_ns - seg.start_ns) / step));
      for (let i = first; i < last; i++) {
        const start_ns = seg.start_ns + i * step;
        intervals.push({ start_ns, end_ns: start_ns + step, v: channels.pickBit(seg.bits[i]) });
      }
    }

    if (intervals.length === 0) return { hasClipped: false };

    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.plotLeft, box.top, layout.plotWidth, box.height);
    ctx.clip();

    ctx.beginPath();
    ctx.strokeStyle = channels.color;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    let hasPoint = false;
    for (const iv of intervals) {
      let v = iv.v;
      if (v < min_v) {
        v = min_v;
        hasClipped = true;
      } else if (v > max_v) {
        v = max_v;
        hasClipped = true;
      }

      const x0 = scale.xOf_ns(iv.start_ns);
      const x1 = scale.xOf_ns(iv.end_ns);
      const y = yOf_v(box, v);

      if (!hasPoint) {
        ctx.moveTo(x0, y);
        hasPoint = true;
      } else {
        ctx.lineTo(x0, y);
      }
      ctx.lineTo(x1, y);
    }
    ctx.stroke();
    ctx.restore();

    return { hasClipped };
  }

  /* 缩小时一屏塞进上万比特，逐比特画又慢又看不清，按像素列取电平上下限就够了 */
  function drawAggregatedTrace(ctx, layout, box, timeline, scale, view) {
    const { min_v, max_v } = box.channel;
    const channel = box.channel;
    const segments = model.segmentsIn(timeline, view.t0_ns, view.t0_ns + view.span_ns);
    if (segments.length === 0) return { hasClipped: false };

    let hasClipped = false;
    let index = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(layout.plotLeft, box.top, layout.plotWidth, box.height);
    ctx.clip();

    ctx.beginPath();
    ctx.strokeStyle = channel.color;
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';

    for (let px = 0; px < layout.plotWidth; px++) {
      const t0_ns = scale.tOf_x(layout.plotLeft + px);
      const t1_ns = scale.tOf_x(layout.plotLeft + px + 1);

      while (index < segments.length && segments[index].end_ns <= t0_ns) index++;

      let lo = Infinity;
      let hi = -Infinity;

      for (let j = index; j < segments.length; j++) {
        const seg = segments[j];
        if (seg.start_ns >= t1_ns) break;

        if (seg.kind === 'lp') {
          const v = channel.pickLp(seg);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          continue;
        }

        const step = seg.ui_ns;
        const first = Math.max(0, Math.floor((t0_ns - seg.start_ns) / step));
        const last = Math.min(seg.bits.length, Math.ceil((t1_ns - seg.start_ns) / step));
        for (let i = first; i < last; i++) {
          const v = channel.pickBit(seg.bits[i]);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }

      if (lo === Infinity) continue;
      if (lo < min_v) {
        lo = min_v;
        hasClipped = true;
      }
      if (hi > max_v) {
        hi = max_v;
        hasClipped = true;
      }

      const x = layout.plotLeft + px + 0.5;
      const yTop = yOf_v(box, hi);
      const yBottom = yOf_v(box, lo);
      ctx.moveTo(x, yTop);
      ctx.lineTo(x, Math.max(yTop + 0.6, yBottom));
    }

    ctx.stroke();
    ctx.restore();

    return { hasClipped };
  }

  function drawChannelTrace(ctx, layout, box, timeline, scale, view) {
    const pxPerBit = timeline.ui_ns * scale.pxPer_ns;
    return pxPerBit < 1.2
      ? drawAggregatedTrace(ctx, layout, box, timeline, scale, view)
      : drawDetailedTrace(ctx, layout, box, timeline, scale, view);
  }

  /* 把低功耗状态名直接写在波形上，省得每次回头对照色带 */
  function drawLpStateLabels(ctx, layout, timeline, scale, view) {
    const box = layout.channelBoxes[0];
    const minWidth_px = 44;

    ctx.save();
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#9aa5b5';

    let previousState = null;

    for (const seg of model.segmentsIn(timeline, view.t0_ns, view.t0_ns + view.span_ns)) {
      if (seg.kind !== 'lp') {
        previousState = null;
        continue;
      }
      /* 退出和末尾空闲都是 LP-11，挨在一起只标一次就够了 */
      if (seg.state === previousState) continue;

      const x0 = scale.xOf_ns(seg.start_ns);
      const x1 = scale.xOf_ns(seg.end_ns);
      if (x1 - x0 < minWidth_px) continue;

      previousState = seg.state;
      const midX = Math.max(layout.plotLeft + 24, Math.min(layout.plotRight - 24, (x0 + x1) / 2));
      ctx.fillText(seg.state, midX, box.top + box.height * 0.34);
    }
    ctx.restore();
  }

  /* 放大到能分清每个比特时，把 0 和 1 标在差分通道顶上 */
  function drawBitLabels(ctx, layout, timeline, scale, view) {
    const box = layout.channelBoxes[layout.channelBoxes.length - 1];
    const minBitWidth_px = 13;
    const y = box.top + 13;

    ctx.save();
    ctx.font = '9px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (const seg of model.segmentsIn(timeline, view.t0_ns, view.t0_ns + view.span_ns)) {
      if (seg.kind !== 'hs') continue;
      if (seg.stageKey === 'zero' || seg.stageKey === 'trail') continue;

      const bitWidth_px = seg.ui_ns * scale.pxPer_ns;
      if (bitWidth_px < minBitWidth_px) continue;

      const first = Math.max(0, Math.floor((view.t0_ns - seg.start_ns) / seg.ui_ns));
      const last = Math.min(seg.bits.length, Math.ceil((view.t0_ns + view.span_ns - seg.start_ns) / seg.ui_ns));

      for (let i = first; i < last; i++) {
        const cx = scale.xOf_ns(seg.start_ns + (i + 0.5) * seg.ui_ns);
        if (cx < layout.plotLeft + 5 || cx > layout.plotRight - 5) continue;

        const bit = seg.bits[i];
        /* 同步头垫一层紫色底，因为它和前面一长串 0 长得一模一样，不标出来根本分不出界线 */
        if (seg.stageKey === 'sync') {
          ctx.fillStyle = bit ? 'rgba(124, 58, 237, 0.16)' : 'rgba(124, 58, 237, 0.07)';
          ctx.fillRect(cx - bitWidth_px / 2 + 1, y - 7, bitWidth_px - 2, 14);
        }

        if (seg.stageKey === 'sync') {
          ctx.fillStyle = bit ? '#5b21b6' : '#8b5cf6';
        } else {
          ctx.fillStyle = bit ? '#0f9d58' : '#aab6c6';
        }
        ctx.fillText(String(bit), cx, y);
      }
    }
    ctx.restore();
  }

  function drawClippingBadge(ctx, layout, box) {
    ctx.save();
    ctx.fillStyle = '#d9534f';
    ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('超出量程', layout.plotRight - 8, box.top + 13);
    ctx.restore();
  }

  /* 高速段的单端摆幅只有 200mV，放在 0~1.4V 的量程里就是贴地一条线，点一句省得误会 */
  function drawSwingHint(ctx, layout, timeline, view) {
    /* 窄屏上这行字会直接压在波形上，宁可不提示 */
    if (layout.plotWidth < 620) return;

    const hasHs = model
      .segmentsIn(timeline, view.t0_ns, view.t0_ns + view.span_ns)
      .some((seg) => seg.kind === 'hs');
    if (!hasHs) return;

    ctx.save();
    ctx.fillStyle = '#b3bcc9';
    ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const box of layout.channelBoxes) {
      if (box.channel.isDiff) continue;
      /* 放中间偏下：低功耗只有 0 和 1.2V 两个电平，高速又贴地，中间那条带子永远是空的 */
      ctx.fillText('高速段摆幅仅 200 mV', layout.plotRight - 8, box.top + box.height * 0.56);
    }
    ctx.restore();
  }

  /* ---------- 时间轴 ---------- */

  function drawTimeAxis(ctx, layout, scale, view) {
    const step_ns = timeStep_nsFor(layout.plotWidth, view.span_ns);
    const first = Math.ceil(view.t0_ns / step_ns) * step_ns;

    ctx.save();
    ctx.strokeStyle = '#dde3ec';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(layout.plotLeft, layout.axisTop + 0.5);
    ctx.lineTo(layout.plotRight, layout.axisTop + 0.5);
    ctx.stroke();

    ctx.fillStyle = '#9aa5b5';
    ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let t = first; t <= view.t0_ns + view.span_ns; t += step_ns) {
      const x = scale.xOf_ns(t);
      if (x < layout.plotLeft - 1 || x > layout.plotRight + 1) continue;
      ctx.strokeStyle = '#dde3ec';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, layout.axisTop);
      ctx.lineTo(Math.round(x) + 0.5, layout.axisTop + 5);
      ctx.stroke();

      const label = Math.abs(t) < step_ns / 1000 ? '0' : model.formatTick_ns(t, step_ns);
      ctx.fillText(label, x, layout.axisTop + 9);
    }

    ctx.fillStyle = '#b6bfcc';
    ctx.font = '10px system-ui, -apple-system, "PingFang SC", sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('时间', 12, layout.axisTop + 9);
    ctx.restore();
  }

  /* ---------- 光标与测量 ---------- */

  function drawCursor(ctx, layout, scale, cursor_ns, marks) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1;

    if (cursor_ns !== null && cursor_ns !== undefined) {
      const x = Math.round(scale.xOf_ns(cursor_ns)) + 0.5;
      if (x >= layout.plotLeft && x <= layout.plotRight) {
        ctx.beginPath();
        ctx.moveTo(x, layout.ribbonTop);
        ctx.lineTo(x, layout.plotBottom);
        ctx.stroke();

        const label = model.formatTime_ns(cursor_ns);
        ctx.setLineDash([]);
        ctx.font = '10px ui-monospace, Menlo, Consolas, monospace';
        const tw = ctx.measureText(label).width + 10;
        const bx = Math.min(Math.max(x - tw / 2, layout.plotLeft), layout.plotRight - tw);

        ctx.fillStyle = '#5b6675';
        roundedRectPath(ctx, bx, layout.plotBottom - 17, tw, 14, 3);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + tw / 2, layout.plotBottom - 10);
      }
    }

    if (marks && marks.length === 2) {
      const [a, b] = marks.slice().sort((m, n) => m - n);
      const xa = scale.xOf_ns(a);
      const xb = scale.xOf_ns(b);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = '#2563eb';
      for (const x of [xa, xb]) {
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + 0.5, layout.ribbonTop);
        ctx.lineTo(Math.round(x) + 0.5, layout.plotBottom);
        ctx.stroke();
      }

      ctx.setLineDash([]);
      const yArrow = layout.plotTop + 9;
      if (xb - xa > 4) {
        /* 先铺一道白底再上蓝线，不然和同色的波形线条粘成一团 */
        for (const [color, width] of [['rgba(255,255,255,0.95)', 4.5], ['#2563eb', 1.4]]) {
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(xa, yArrow);
          ctx.lineTo(xb, yArrow);
          ctx.stroke();
        }
        for (const [x, dir] of [[xa, 1], [xb, -1]]) {
          ctx.beginPath();
          ctx.moveTo(x, yArrow);
          ctx.lineTo(x + 5 * dir, yArrow - 3.5);
          ctx.lineTo(x + 5 * dir, yArrow + 3.5);
          ctx.closePath();
          ctx.fillStyle = '#2563eb';
          ctx.fill();
        }

        /* 数值直接摆在箭头下方，不用低头看读数条 */
        const label = model.formatTime_ns(b - a);
        ctx.font = '600 11px ui-monospace, Menlo, Consolas, monospace';
        const tw = ctx.measureText(label).width + 12;
        const bx = Math.min(Math.max((xa + xb) / 2 - tw / 2, layout.plotLeft), layout.plotRight - tw);

        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        roundedRectPath(ctx, bx, yArrow + 6, tw, 15, 4);
        ctx.fill();
        ctx.strokeStyle = 'rgba(37,99,235,0.35)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = '#1d4ed8';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx + tw / 2, yArrow + 13.5);
      }
    }
    ctx.restore();
  }

  /* ---------- 主入口 ---------- */

  function drawScope(ctx, opts) {
    const layout = computeLayout(opts.width, opts.height);
    const scale = makeScale(layout, opts.view);

    drawBackground(ctx, layout);
    drawGrid(ctx, layout, scale, opts.view);
    drawChannelFrames(ctx, layout);

    for (const box of layout.channelBoxes) {
      const result = drawChannelTrace(ctx, layout, box, opts.timeline, scale, opts.view);
      if (result.hasClipped) drawClippingBadge(ctx, layout, box);
    }

    const visiblePackets = model.packetsIn(opts.timeline, opts.view.t0_ns, opts.view.t0_ns + opts.view.span_ns);
    /* 帧间隙也是宽块，但它没有字段可标，不能算进来 */
    const hasWidePacket = visiblePackets.some(
      (packet) =>
        packet.fields && scale.xOf_ns(packet.end_ns) - scale.xOf_ns(packet.start_ns) > FIELD_MIN_PACKET_PX
    );

    drawLpStateLabels(ctx, layout, opts.timeline, scale, opts.view);
    drawBitLabels(ctx, layout, opts.timeline, scale, opts.view);
    drawPhaseRibbon(ctx, layout, opts.timeline, scale, opts.view);
    if (hasWidePacket) drawFieldBar(ctx, layout, opts.timeline, scale, opts.view);
    else drawFrameMarkers(ctx, layout, opts.timeline, scale, opts.view);
    drawTimeAxis(ctx, layout, scale, opts.view);
    drawSwingHint(ctx, layout, opts.timeline, opts.view);
    drawCursor(ctx, layout, scale, opts.cursor_ns, opts.marks);

    return { layout, step_ns: timeStep_nsFor(layout.plotWidth, opts.view.span_ns) };
  }

  /* ---------- 缩略图 ---------- */

  function drawOverview(ctx, opts) {
    const { width, height, timeline, view } = opts;
    ctx.clearRect(0, 0, width, height);

    const padX = 2;
    const padY = 6;
    const usableW = width - padX * 2;
    const usableH = height - padY * 2;
    const duration = Math.max(1, timeline.duration_ns);

    const xOf = (t) => padX + (t / duration) * usableW;
    /* 按真实电压映射，高速段那点摆幅自然就缩在底部，缩略图才不会被抖动堵满 */
    const yOf = (v) => padY + usableH - (Math.min(1.3, Math.max(-0.05, v)) / 1.3) * usableH;
    const HS_LOW_V = model.HS_LEVEL[0].dp_v;
    const HS_HIGH_V = model.HS_LEVEL[1].dp_v;

    ctx.save();
    ctx.beginPath();
    ctx.rect(padX, padY, usableW, usableH);
    ctx.clip();

    /* 先铺一层包级底色，哪些地方在传数据、哪些地方在干等，一眼就能分开 */
    ctx.globalAlpha = 0.12;
    for (const packet of timeline.packets) {
      const style = model.PACKET_STYLE[packet.kind] || { color: '#9aa7b8' };
      ctx.fillStyle = style.color;
      ctx.fillRect(xOf(packet.start_ns), padY, Math.max(0.6, xOf(packet.end_ns) - xOf(packet.start_ns)), usableH);
    }
    ctx.globalAlpha = 1;

    /* 一列一像素，列内取电平范围画竖线，和示波器的峰值检测一个意思 */
    const segments = timeline.segments;
    let index = 0;

    ctx.beginPath();
    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1;

    for (let px = 0; px < usableW; px++) {
      const t0_ns = (px / usableW) * duration;
      const t1_ns = ((px + 1) / usableW) * duration;
      const x = padX + px + 0.5;

      while (index < segments.length && segments[index].end_ns <= t0_ns) index++;

      let min_v = Infinity;
      let max_v = -Infinity;

      for (let j = index; j < segments.length; j++) {
        const seg = segments[j];
        if (seg.start_ns >= t1_ns) break;

        if (seg.kind === 'lp') {
          if (seg.dp_v < min_v) min_v = seg.dp_v;
          if (seg.dp_v > max_v) max_v = seg.dp_v;
          continue;
        }

        const step = seg.ui_ns;
        const first = Math.max(0, Math.floor((t0_ns - seg.start_ns) / step));
        const last = Math.min(seg.bits.length, Math.ceil((t1_ns - seg.start_ns) / step));
        for (let i = first; i < last; i++) {
          const v = seg.bits[i] ? HS_HIGH_V : HS_LOW_V;
          if (v < min_v) min_v = v;
          if (v > max_v) max_v = v;
        }
      }

      if (min_v === Infinity) continue;
      ctx.moveTo(x, yOf(min_v));
      ctx.lineTo(x, yOf(max_v) - 0.01);
    }
    ctx.stroke();
    ctx.restore();

    /* 当前视口 */
    const vx0 = Math.max(padX, xOf(view.t0_ns));
    const vx1 = Math.min(padX + usableW, xOf(view.t0_ns + view.span_ns));

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
    ctx.fillRect(padX, padY, Math.max(0, vx0 - padX), usableH);
    ctx.fillRect(vx1, padY, Math.max(0, padX + usableW - vx1), usableH);

    ctx.strokeStyle = '#2563eb';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(vx0 + 0.5, padY + 0.5, Math.max(3, vx1 - vx0), usableH - 1);
    ctx.restore();
  }

  ns.render = {
    computeLayout,
    drawScope,
    drawOverview,
    timeStep_nsFor,
  };
})(window.MIPI = window.MIPI || {});
