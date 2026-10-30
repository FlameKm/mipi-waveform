/* MIPI D-PHY 波形模型
 *
 * 一条数据线连着的时候，干的事只有一件：一帧接一帧往回搬图像。
 * 每帧 = 帧起始短包 + 每行一个长包 + 帧结束短包，包与包之间、帧与帧之间都是 LP-11 空闲。
 *
 * 时间统一用纳秒，电压统一用伏特，变量名带单位后缀。
 */
(function (ns) {
  'use strict';

  const V_LP_HIGH = 1.2;
  const V_HS_HIGH = 0.3;
  const V_HS_LOW = 0.1;

  /* 低功耗四态的电平。状态名后两位就是 Dp、Dn 的高低 */
  const LP_LEVEL = {
    'LP-00': [0, 0],
    'LP-01': [0, V_LP_HIGH],
    'LP-10': [V_LP_HIGH, 0],
    'LP-11': [V_LP_HIGH, V_LP_HIGH],
  };

  /* 差分 1 时 Dp 抬高、Dn 压低，差分 0 反过来 */
  const HS_LEVEL = [
    { dp_v: V_HS_LOW, dn_v: V_HS_HIGH },
    { dp_v: V_HS_HIGH, dn_v: V_HS_LOW },
  ];

  /* 同步头：一长串 0 之后这 8 位就是字节边界的锚点 */
  const SYNC_BITS = Uint8Array.from([0, 0, 0, 1, 1, 1, 0, 1]);

  const RATE_CHOICES_BPS = [80e6, 200e6, 500e6, 1e9, 1.5e9, 2.5e9];
  const LINES_CHOICES = [4, 8, 16, 32];
  const PAYLOAD_CHOICES_BYTES = [16, 32, 64, 128];
  const FRAME_CHOICES = [2, 3, 4];

  /* 帧间隙按帧内数据时长的倍数算，紧凑就是连着发，宽松就是慢帧率 */
  const VBLANK_CHOICES = [
    { key: 'tight', label: '紧凑', factor: 0.4 },
    { key: 'normal', label: '标准', factor: 1.1 },
    { key: 'loose', label: '宽松', factor: 3.2 },
  ];

  /* 以下下限取自 D-PHY 1.x 的公开数值，具体以芯片实际用的版本为准 */
  const T_LPX_NS = 50;
  const T_HS_EXIT_NS = 100;

  const tHsPrepare_ns = (ui_ns) => Math.max(40 + 4 * ui_ns, 45);
  const tHsZero_ns = (ui_ns) => 105 + 12 * ui_ns;
  const tHsTrail_ns = (ui_ns) => 60 + 4 * ui_ns;

  const SHORT_PACKET_FIELDS = [
    { offset: 0, len_bytes: 1, name: '数据标识' },
    { offset: 1, len_bytes: 2, name: '帧号' },
    { offset: 3, len_bytes: 1, name: '校验' },
  ];

  const longPacketFields = (payloadLen_bytes) => [
    { offset: 0, len_bytes: 1, name: '数据标识' },
    { offset: 1, len_bytes: 2, name: '字长' },
    { offset: 3, len_bytes: 1, name: '校验' },
    { offset: 4, len_bytes: payloadLen_bytes, name: '载荷' },
    { offset: 4 + payloadLen_bytes, len_bytes: 2, name: 'CRC' },
  ];

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function bytesToBits(bytes) {
    const bits = new Uint8Array(bytes.length * 8);
    let cursor = 0;
    for (const byte of bytes) {
      for (let i = 0; i < 8; i++) bits[cursor++] = (byte >> i) & 1;
    }
    return bits;
  }

  /* 帧起始 0x00、帧结束 0x01，都是四字节短包，帧号塞在字长那两格里 */
  function buildFrameShortPacket(dataType, frameIndex) {
    return [dataType, frameIndex & 0xff, (frameIndex >> 8) & 0xff, 0x00];
  }

  /* 每行一个长包。载荷用行号做种子，所以每行内容都不一样 */
  function buildLinePacket(frameIndex, lineIndex, payloadLen_bytes, seedBase) {
    const bytes = [];
    const push = (v) => bytes.push(v & 0xff);

    push(0x2c); // 虚拟通道 0，类型 0x2C 即 RAW8
    push(payloadLen_bytes & 0xff);
    push((payloadLen_bytes >> 8) & 0xff);
    push(0x00); // 包头校验，示意值

    const rnd = mulberry32(seedBase + frameIndex * 977 + lineIndex * 31);
    for (let i = 0; i < payloadLen_bytes; i++) push(Math.floor(rnd() * 256));

    push(0x00); // 包尾校验，示意值
    push(0x00);
    return bytes;
  }

  /**
   * 把整条线的行为铺成时间线。
   * opts: { rate_bps, linesPerFrame, payloadLen_bytes, frameCount, vblankKey, isEscaping, seed }
   */
  function build(opts) {
    const ui_ns = 1e9 / opts.rate_bps;
    const segments = [];
    const packets = [];
    const frames = [];
    let t_ns = 0;

    let currentStageKey = null;

    const addLp = (state, dur_ns, label) => {
      const [dp_v, dn_v] = LP_LEVEL[state];
      const end_ns = t_ns + dur_ns;
      segments.push({
        kind: 'lp',
        state,
        start_ns: t_ns,
        end_ns,
        dp_v,
        dn_v,
        packetLabel: label,
        stageKey: currentStageKey,
      });
      t_ns = end_ns;
    };

    const addHs = (bits, label) => {
      const start_ns = t_ns;
      const end_ns = start_ns + bits.length * ui_ns;
      segments.push({ kind: 'hs', bits, start_ns, end_ns, ui_ns, packetLabel: label, stageKey: currentStageKey });
      t_ns = end_ns;
      return { start_ns, end_ns };
    };

    /* 一个高速包从 LP-11 里出来，跑完再回到 LP-11 的全过程 */
    const addBurst = (payload, meta) => {
      const label = meta.label;
      const traceLabel = meta.where || meta.label;
      const start_ns = t_ns;
      const stages = [];
      const fields = [];

      const openStage = (key) => {
        const stage = { key, start_ns: t_ns };
        stages.push(stage);
        currentStageKey = key;
        return stage;
      };
      const closeStage = (stage) => {
        stage.end_ns = t_ns;
      };

      let stage = openStage('request');
      addLp('LP-01', T_LPX_NS, traceLabel);
      closeStage(stage);

      stage = openStage('prepare');
      addLp('LP-00', tHsPrepare_ns(ui_ns), traceLabel);
      closeStage(stage);

      /* 差分拉 0 并保持住，让终端电阻和共模电压安顿下来 */
      stage = openStage('zero');
      addHs(new Uint8Array(Math.max(8, Math.ceil(tHsZero_ns(ui_ns) / ui_ns))), traceLabel);
      closeStage(stage);

      stage = openStage('sync');
      addHs(SYNC_BITS, traceLabel);
      closeStage(stage);

      stage = openStage('data');
      for (const field of meta.fields) {
        const chunk = payload.slice(field.offset, field.offset + field.len_bytes);
        const span = addHs(bytesToBits(chunk), traceLabel);
        fields.push({ name: field.name, start_ns: span.start_ns, end_ns: span.end_ns });
      }
      closeStage(stage);

      stage = openStage('trail');
      addHs(new Uint8Array(Math.max(4, Math.ceil(tHsTrail_ns(ui_ns) / ui_ns))), traceLabel);
      closeStage(stage);

      stage = openStage('exit');
      addLp('LP-11', T_HS_EXIT_NS, traceLabel);
      closeStage(stage);

      const burst = {
        kind: meta.kind,
        label,
        start_ns,
        end_ns: t_ns,
        frameIndex: meta.frameIndex,
        lineIndex: meta.lineIndex,
        stages,
        fields,
      };
      packets.push(burst);
      return burst;
    };

    const addGap = (dur_ns, kind, label, frameIndex) => {
      const start_ns = t_ns;
      currentStageKey = null;
      addLp('LP-11', dur_ns, label);
      packets.push({ kind, label, start_ns, end_ns: t_ns, frameIndex });
    };

    const linesPerFrame = opts.linesPerFrame;
    const payloadLen_bytes = opts.payloadLen_bytes;
    const frameCount = opts.frameCount;
    const vblankChoice = VBLANK_CHOICES.find((c) => c.key === opts.vblankKey) || VBLANK_CHOICES[1];

    /* 先按规范下限估出各类包的时长，间隙由它推出来，改速率时比例才不会崩 */
    const shortPayloadBits = 4 * 8;
    const linePayloadBits = (payloadLen_bytes + 6) * 8;
    const burstOverhead_ns =
      T_LPX_NS + tHsPrepare_ns(ui_ns) + tHsZero_ns(ui_ns) + SYNC_BITS.length * ui_ns + tHsTrail_ns(ui_ns) + T_HS_EXIT_NS;

    const shortBurst_ns = burstOverhead_ns + shortPayloadBits * ui_ns;
    const lineBurst_ns = burstOverhead_ns + linePayloadBits * ui_ns;
    const lineGap_ns = Math.max(80, lineBurst_ns * 0.45);

    const frameData_ns = (shortBurst_ns + lineGap_ns) * 2 + linesPerFrame * (lineBurst_ns + lineGap_ns);
    const vblank_ns = Math.max(lineGap_ns, frameData_ns * vblankChoice.factor);

    addGap(lineGap_ns, 'lineGap', '空闲', -1);

    for (let f = 0; f < frameCount; f++) {
      const frameStart_ns = t_ns;
      const frameLabel = `帧 ${f + 1}`;

      addBurst(buildFrameShortPacket(0x00, f), {
        kind: 'frameStart',
        label: '帧起始',
        where: `${frameLabel} · 帧起始`,
        frameIndex: f,
        fields: SHORT_PACKET_FIELDS,
      });
      addGap(lineGap_ns, 'lineGap', '行间隙', f);

      for (let l = 0; l < linesPerFrame; l++) {
        addBurst(buildLinePacket(f, l, payloadLen_bytes, opts.seed || 1), {
          kind: 'line',
          label: `行 ${l + 1}`,
          where: `${frameLabel} · 第 ${l + 1} 行`,
          frameIndex: f,
          lineIndex: l,
          fields: longPacketFields(payloadLen_bytes),
        });
        addGap(lineGap_ns, 'lineGap', '行间隙', f);
      }

      addBurst(buildFrameShortPacket(0x01, f), {
        kind: 'frameEnd',
        label: '帧结束',
        where: `${frameLabel} · 帧结束`,
        frameIndex: f,
        fields: SHORT_PACKET_FIELDS,
      });
      addGap(vblank_ns, 'vblank', '帧间隙', f);

      frames.push({ index: f, start_ns: frameStart_ns, end_ns: t_ns });
    }

    if (opts.isEscaping) {
      /* 逃逸方向反过来：先把 Dp 拉成 LP-10，绕一圈再发低速命令 */
      const start_ns = t_ns;
      const stages = [{ key: 'escape', start_ns }];
      currentStageKey = 'escape';
      addLp('LP-10', T_LPX_NS, '逃逸');
      addLp('LP-00', T_LPX_NS, '逃逸');
      addLp('LP-01', T_LPX_NS, '逃逸');
      addLp('LP-00', T_LPX_NS, '逃逸');
      for (const bit of [0, 1, 1, 0, 1, 0, 0, 1]) {
        addLp(bit ? 'LP-01' : 'LP-00', T_LPX_NS, '逃逸');
      }
      stages[0].end_ns = t_ns;
      packets.push({ kind: 'escape', label: '逃逸命令', start_ns, end_ns: t_ns, frameIndex: -1, stages });

      currentStageKey = null;
      addLp('LP-11', vblank_ns, '');
      packets.push({ kind: 'vblank', label: '帧间隙', start_ns: t_ns - vblank_ns, end_ns: t_ns, frameIndex: -1 });
    }

    return {
      rate_bps: opts.rate_bps,
      ui_ns,
      segments,
      packets,
      frames,
      duration_ns: t_ns,
      lineGap_ns,
      vblank_ns,
      linesPerFrame,
      payloadLen_bytes,
      frameCount,
    };
  }

  function firstIndexEndingAfter(items, t_ns) {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].end_ns <= t_ns) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function segmentsIn(timeline, t0_ns, t1_ns) {
    const out = [];
    const items = timeline.segments;
    for (let i = firstIndexEndingAfter(items, t0_ns); i < items.length; i++) {
      if (items[i].start_ns >= t1_ns) break;
      out.push(items[i]);
    }
    return out;
  }

  function packetsIn(timeline, t0_ns, t1_ns) {
    const out = [];
    const items = timeline.packets;
    for (let i = firstIndexEndingAfter(items, t0_ns); i < items.length; i++) {
      if (items[i].start_ns >= t1_ns) break;
      out.push(items[i]);
    }
    return out;
  }

  const LP_STATE_MEANING = {
    'LP-11': '静止，线路空闲',
    'LP-10': '逃逸入口，准备走低速',
    'LP-01': '请求高速，等对方回应',
    'LP-00': '过渡态，即将切换',
  };

  /** 屏幕上某一刻发生了什么，光标读数靠它 */
  function describeAt(timeline, t_ns) {
    if (t_ns < 0) return null;

    const segs = timeline.segments;
    const i = firstIndexEndingAfter(segs, t_ns);
    if (i >= segs.length) return null;

    const seg = segs[i];
    const where = seg.packetLabel || '';

    if (seg.kind === 'lp') {
      return {
        title: seg.state,
        detail: LP_STATE_MEANING[seg.state] || '',
        where,
        dp_v: seg.dp_v,
        dn_v: seg.dn_v,
      };
    }

    const bitIndex = Math.min(seg.bits.length - 1, Math.floor((t_ns - seg.start_ns) / seg.ui_ns));
    const bit = seg.bits[bitIndex];
    const level = HS_LEVEL[bit];

    return {
      title: bit ? '差分 1' : '差分 0',
      detail: `第 ${bitIndex + 1} 个比特`,
      where,
      dp_v: level.dp_v,
      dn_v: level.dn_v,
    };
  }

  const STAGE_STYLE = {
    request: { name: '请求', color: '#e0a12a' },
    prepare: { name: '准备', color: '#e0a12a' },
    zero: { name: '稳定', color: '#5b8def' },
    sync: { name: '同步', color: '#8b5cf6' },
    data: { name: '数据', color: '#16a37a' },
    trail: { name: '收尾', color: '#5b8def' },
    exit: { name: '退出', color: '#9aa7b8' },
    escape: { name: '逃逸', color: '#d9538c' },
  };

  const PACKET_STYLE = {
    frameStart: { name: '帧起始', color: '#8b5cf6' },
    line: { name: '行数据', color: '#16a37a' },
    frameEnd: { name: '帧结束', color: '#8b5cf6' },
    lineGap: { name: '行间隙', color: '#b6c2d2' },
    vblank: { name: '帧间隙', color: '#c9d3e0' },
    escape: { name: '逃逸', color: '#d9538c' },
  };

  function formatTime_ns(t_ns) {
    const abs = Math.abs(t_ns);
    const sign = t_ns < 0 ? '-' : '';
    if (abs < 1) return `${sign}${(abs * 1000).toFixed(0)} ps`;
    if (abs < 10) return `${sign}${abs.toFixed(3)} ns`;
    if (abs < 100) return `${sign}${abs.toFixed(2)} ns`;
    if (abs < 1000) return `${sign}${abs.toFixed(1)} ns`;
    if (abs < 1e4) return `${sign}${(abs / 1000).toFixed(3)} µs`;
    if (abs < 1e6) return `${sign}${(abs / 1000).toFixed(2)} µs`;
    return `${sign}${(abs / 1e6).toFixed(2)} ms`;
  }

  /* 轴刻度要按格距定精度，否则放大到二百皮秒时一排标签会全都长成一个样 */
  function formatTick_ns(t_ns, step_ns) {
    const abs = Math.abs(t_ns);
    const sign = t_ns < 0 ? '-' : '';
    const unit = abs >= 1e6 ? 1e6 : abs >= 1000 ? 1000 : 1;
    const suffix = unit === 1e6 ? 'ms' : unit === 1000 ? 'µs' : 'ns';
    const stepInUnit = step_ns / unit;
    const digits = Math.max(0, Math.min(4, Math.ceil(-Math.log10(stepInUnit))));
    return `${sign}${(abs / unit).toFixed(digits)} ${suffix}`;
  }

  function formatVoltage_v(v) {
    const abs = Math.abs(v);
    if (abs < 1) return `${(v * 1000).toFixed(0)} mV`;
    return `${v.toFixed(2)} V`;
  }

  /** 刻度取 1、2、5 的整数倍，和示波器一个习惯 */
  function tickStep_ns(span_ns, targetCount) {
    const raw = span_ns / Math.max(1, targetCount);
    const exp = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const m = raw / base;
    const mult = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
    return mult * base;
  }

  ns.model = {
    build,
    segmentsIn,
    packetsIn,
    describeAt,
    formatTime_ns,
    formatTick_ns,
    formatVoltage_v,
    tickStep_ns,
    HS_LEVEL,
    LP_LEVEL,
    STAGE_STYLE,
    PACKET_STYLE,
    RATE_CHOICES_BPS,
    LINES_CHOICES,
    PAYLOAD_CHOICES_BYTES,
    FRAME_CHOICES,
    VBLANK_CHOICES,
  };
})(window.MIPI = window.MIPI || {});
