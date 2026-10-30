/* MIPI D-PHY 波形模型
 *
 * 一帧图像传多久不是拍脑袋给的，是从传感器配置反推出来的：
 *   时钟 lane 频率 × 2        → 比特率
 *   分辨率 + 数据格式         → 每行多少字节
 *   lane 数                  → 每条 lane 分到多少字节 → 包有多长
 *   HBlank / VBlank          → 行周期和帧周期
 *
 * CSI-2 里没有"消隐波形"这回事：并行 DPI 在消隐期有专门的电平，
 * 而 CSI-2 是包协议，消隐期就是链路挂在 LP-11 上干等。所以消隐值在这里
 * 唯一的作用是把行周期和帧周期拉长，空白段因此变宽。
 *
 * 时间统一用纳秒，电压用伏特，变量名带单位后缀。
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

  /* 像素格式只关心每像素多少位，打包细节（RAW10 每 4 像素塞 5 字节）先不算 */
  const FORMATS = [
    { key: 'RAW8', label: 'RAW8', bitsPerPixel: 8 },
    { key: 'RAW10', label: 'RAW10', bitsPerPixel: 10 },
    { key: 'RAW12', label: 'RAW12', bitsPerPixel: 12 },
    { key: 'RAW14', label: 'RAW14', bitsPerPixel: 14 },
    { key: 'RGB888', label: 'RGB888', bitsPerPixel: 24 },
    { key: 'RGB565', label: 'RGB565', bitsPerPixel: 16 },
    { key: 'YUV422', label: 'YUV422-8', bitsPerPixel: 16 },
  ];

  /* 消隐默认值取各档常见的传感器配置，改分辨率时会一起带过去 */
  const RESOLUTIONS = [
    { key: '320x240', width_px: 320, height_px: 240, hblank_px: 60, vblank_lines: 20 },
    { key: '640x480', width_px: 640, height_px: 480, hblank_px: 120, vblank_lines: 30 },
    { key: '1280x720', width_px: 1280, height_px: 720, hblank_px: 200, vblank_lines: 40 },
    { key: '1920x1080', width_px: 1920, height_px: 1080, hblank_px: 280, vblank_lines: 45 },
    { key: '2560x1440', width_px: 2560, height_px: 1440, hblank_px: 320, vblank_lines: 60 },
    { key: '3840x2160', width_px: 3840, height_px: 2160, hblank_px: 400, vblank_lines: 80 },
  ];

  /* D-PHY 时钟 lane 跑 DDR，一个时钟周期送两个比特 */
  const CLOCK_LANE_CHOICES_MHZ = [50, 100, 200, 300, 400, 500, 750, 1000];
  const LANE_CHOICES = [1, 2, 4];
  const FRAME_CHOICES = [2, 3, 4];

  /* 以下下限取自 D-PHY 1.x 的公开数值，具体以芯片实际用的版本为准 */
  const T_LPX_NS = 50;
  const T_HS_EXIT_NS = 100;

  const tHsPrepare_ns = (ui_ns) => Math.max(40 + 4 * ui_ns, 45);
  const tHsZero_ns = (ui_ns) => 105 + 12 * ui_ns;
  const tHsTrail_ns = (ui_ns) => 60 + 4 * ui_ns;

  const findFormat = (key) => FORMATS.find((f) => f.key === key) || FORMATS[1];

  /* ---------- 比特的来源 ---------- */

  /* 载荷是图像数据，内容对波形毫无意义，只要有 0 有 1 就行。
   * 用确定性哈希按需算，避免给一亿个比特开数组。 */
  function hashBit(seed, index) {
    let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x21f0aaad) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x735a2d97) >>> 0;
    return (h ^ (h >>> 15)) & 1;
  }

  /** 段的第 index 个比特。恒定段、显式数组、伪随机三种来源统一走这里 */
  function bitAt(seg, index) {
    if (seg.bits) return seg.bits[index];
    if (seg.constantBit !== undefined) return seg.constantBit;
    return hashBit(seg.prngSeed, index);
  }

  function bytesToBits(bytes) {
    const bits = new Uint8Array(bytes.length * 8);
    let cursor = 0;
    for (const byte of bytes) {
      for (let i = 0; i < 8; i++) bits[cursor++] = (byte >> i) & 1;
    }
    return bits;
  }

  /* ---------- 包的字节内容 ---------- */

  /* 帧起始 0x00、帧结束 0x01，都是四字节短包，帧号塞在字长那两格里 */
  function buildFrameShortPacket(dataType, frameIndex) {
    return Uint8Array.from([dataType, frameIndex & 0xff, (frameIndex >> 8) & 0xff, 0x00]);
  }

  /* 每行一个长包。载荷不生成，只留字节数和种子 */
  function buildLinePacket(dataType, payloadBytes, lineKey) {
    return {
      head: Uint8Array.from([
        dataType,
        payloadBytes & 0xff,
        (payloadBytes >> 8) & 0xff,
        0x00, // 包头校验，示意值
      ]),
      payloadSeed: (lineKey * 2654435761) >>> 0,
      crc: Uint8Array.from([0x00, 0x00]), // 包尾校验，示意值
    };
  }

  /* 数据标识：虚拟通道 0 加上各格式的类型码 */
  const DATA_TYPE_BY_FORMAT = {
    RAW8: 0x2a,
    RAW10: 0x2b,
    RAW12: 0x2c,
    RAW14: 0x2d,
    RGB888: 0x24,
    RGB565: 0x22,
    YUV422: 0x1e,
  };

  const SHORT_PACKET_FIELDS = [
    { part: 'head', offset: 0, len_bytes: 1, name: '数据标识' },
    { part: 'head', offset: 1, len_bytes: 2, name: '帧号' },
    { part: 'head', offset: 3, len_bytes: 1, name: '校验' },
  ];

  const longPacketFields = (payloadBytes) => [
    { part: 'head', offset: 0, len_bytes: 1, name: '数据标识' },
    { part: 'head', offset: 1, len_bytes: 2, name: '字长' },
    { part: 'head', offset: 3, len_bytes: 1, name: '校验' },
    { part: 'payload', len_bytes: payloadBytes, name: '载荷' },
    { part: 'crc', offset: 0, len_bytes: 2, name: 'CRC' },
  ];

  /**
   * 从传感器配置反推时间尺度。所有统计口径都在这里定死，页面只负责显示。
   * opts: { clockLane_mhz, laneCount, formatKey, width_px, height_px,
   *         hblank_px, vblank_lines, frameCount, isEscaping, seed }
   */
  function deriveTiming(opts) {
    const format = findFormat(opts.formatKey);
    const bitRate_bps = opts.clockLane_mhz * 1e6 * 2;
    const ui_ns = 1e9 / bitRate_bps;

    /* 每行像素打包成字节，再补上长包的包头 4 字节和包尾 2 字节 */
    const payloadBytes_bytes = Math.ceil((opts.width_px * format.bitsPerPixel) / 8);
    const lineBytes_bytes = payloadBytes_bytes + 6;

    /* 字节按 lane 轮转分配，除不尽时 lane 0 多摊一个字节 */
    const perLaneBytes_bytes = Math.ceil(lineBytes_bytes / opts.laneCount);

    /* 一个包从离开 LP-11 到回到 LP-11 的固定开销，和载荷多少无关 */
    const overhead_ns =
      T_LPX_NS +
      tHsPrepare_ns(ui_ns) +
      tHsZero_ns(ui_ns) +
      SYNC_BITS.length * ui_ns +
      tHsTrail_ns(ui_ns) +
      T_HS_EXIT_NS;

    const lineActive_ns = overhead_ns + perLaneBytes_bytes * 8 * ui_ns;
    const shortActive_ns = overhead_ns + Math.ceil(4 / opts.laneCount) * 8 * ui_ns;

    /* 消隐按像素比例把行周期拉长，多出来的时间链路挂在 LP-11 上 */
    const hTotal_px = opts.width_px + opts.hblank_px;
    const linePeriod_ns = (lineActive_ns * hTotal_px) / opts.width_px;
    const lineGap_ns = Math.max(0, linePeriod_ns - lineActive_ns);

    /* VBlank 至少要装得下帧起始和帧结束两个包 */
    const vblank_lines = Math.max(2, opts.vblank_lines);
    const vTotal_lines = opts.height_px + vblank_lines;
    const framePeriod_ns = linePeriod_ns * vTotal_lines;

    /* 帧结束包之后到下一帧起始之间的那一整段空闲 */
    const vblank_ns = Math.max(0, (vblank_lines - 1) * linePeriod_ns - shortActive_ns);

    return {
      format,
      bitRate_bps,
      ui_ns,
      laneCount: opts.laneCount,
      payloadBytes_bytes,
      lineBytes_bytes,
      perLaneBytes_bytes,
      overhead_ns,
      lineActive_ns,
      shortActive_ns,
      lineGap_ns,
      hTotal_px,
      vblank_lines,
      vTotal_lines,
      linePeriod_ns,
      framePeriod_ns,
      vblank_ns,
      fps: 1e9 / framePeriod_ns,
      /* 链路真正在传数据的比例：行内活跃时间 × 活跃行数 / 帧周期 */
      dutyPercent: ((lineActive_ns * opts.height_px) / framePeriod_ns) * 100,
      linkBandwidth_bps: bitRate_bps * opts.laneCount,
    };
  }

  /** 把整条线的行为铺成时间线 */
  function build(opts) {
    const timing = deriveTiming(opts);
    const ui_ns = timing.ui_ns;
    const segments = [];
    const packets = [];
    const frames = [];
    const dataType = DATA_TYPE_BY_FORMAT[timing.format.key];
    let t_ns = 0;
    let currentStageKey = null;

    const addLp = (state, dur_ns, label) => {
      if (dur_ns <= 0) return;
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

    const pushHs = (end_ns, payload, label) => {
      segments.push({
        kind: 'hs',
        start_ns: t_ns,
        end_ns,
        ui_ns,
        bitCount: Math.round((end_ns - t_ns) / ui_ns),
        packetLabel: label,
        stageKey: currentStageKey,
        ...payload,
      });
      t_ns = end_ns;
    };

    /* 恒定电平段：稳定期和收尾期全是同一个比特，不用开数组 */
    const addHsConstant = (bitCount, bit, label) => {
      const start_ns = t_ns;
      const end_ns = start_ns + bitCount * ui_ns;
      pushHs(end_ns, { constantBit: bit }, label);
      return { start_ns, end_ns };
    };

    const addHsBits = (bits, label) => {
      const start_ns = t_ns;
      const end_ns = start_ns + bits.length * ui_ns;
      pushHs(end_ns, { bits }, label);
      return { start_ns, end_ns };
    };

    /* 图像载荷不落数组，渲染时按需算 */
    const addHsPayload = (bitCount, prngSeed, label) => {
      const start_ns = t_ns;
      const end_ns = start_ns + bitCount * ui_ns;
      pushHs(end_ns, { prngSeed }, label);
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
      addHsConstant(Math.max(8, Math.ceil(tHsZero_ns(ui_ns) / ui_ns)), 0, traceLabel);
      closeStage(stage);

      stage = openStage('sync');
      addHsBits(SYNC_BITS, traceLabel);
      closeStage(stage);

      /* 这一条 lane 只摊到整包字节数的 1/N，除不尽的那一位落在 lane 0 上 */
      const perLane = (len_bytes) => Math.ceil(len_bytes / laneCount);

      stage = openStage('data');
      for (const field of meta.fields) {
        const bitsHere = perLane(field.len_bytes) * 8;
        let span;
        if (field.part === 'payload') {
          span = addHsPayload(bitsHere, payload.payloadSeed, traceLabel);
        } else {
          const source = field.part === 'crc' ? payload.crc : payload.head;
          span = addHsBits(bytesToBits(source.slice(0, perLane(source.length))), traceLabel);
        }
        fields.push({ name: field.name, start_ns: span.start_ns, end_ns: span.end_ns });
      }
      closeStage(stage);

      stage = openStage('trail');
      addHsConstant(Math.max(4, Math.ceil(tHsTrail_ns(ui_ns) / ui_ns)), 0, traceLabel);
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
      if (t_ns > start_ns) packets.push({ kind, label, start_ns, end_ns: t_ns, frameIndex });
    };

    const frameCount = opts.frameCount;
    const laneCount = timing.laneCount;
    const fields = longPacketFields(timing.payloadBytes_bytes);
    const headBytes = 4;

    for (let f = 0; f < frameCount; f++) {
      const frameStart_ns = t_ns;
      const frameLabel = `帧 ${f + 1}`;

      /* 帧起始住在垂直消隐的开头，占掉一个行周期 */
      const fs = addBurst(
        { head: buildFrameShortPacket(0x00, f), payloadSeed: 0, crc: Uint8Array.from([0, 0]) },
        {
          kind: 'frameStart',
          label: '帧起始',
          where: `${frameLabel} · 帧起始`,
          frameIndex: f,
          fields: SHORT_PACKET_FIELDS.map((item) => ({ ...item })),
        }
      );
      addGap(Math.max(0, timing.linePeriod_ns - (fs.end_ns - fs.start_ns)), 'lineGap', '行间隙', f);

      for (let l = 0; l < opts.height_px; l++) {
        const line = addBurst(buildLinePacket(dataType, timing.payloadBytes_bytes, f * 1048576 + l), {
          kind: 'line',
          label: `行 ${l + 1}`,
          where: `${frameLabel} · 第 ${l + 1} 行`,
          frameIndex: f,
          lineIndex: l,
          fields,
        });
        addGap(timing.lineGap_ns, 'lineGap', '行间隙', f);

        /* 别让帧结束包和最后一个行包挤在一起，节奏要统一 */
        if (l === opts.height_px - 1) {
          const pad = timing.linePeriod_ns - (line.end_ns - line.start_ns) - timing.lineGap_ns;
          if (pad > 0) addGap(pad, 'lineGap', '行间隙', f);
        }
      }

      const fe = addBurst(
        { head: buildFrameShortPacket(0x01, f), payloadSeed: 0, crc: Uint8Array.from([0, 0]) },
        {
          kind: 'frameEnd',
          label: '帧结束',
          where: `${frameLabel} · 帧结束`,
          frameIndex: f,
          fields: SHORT_PACKET_FIELDS.map((item) => ({ ...item })),
        }
      );
      addGap(Math.max(0, timing.vblank_ns + (timing.shortActive_ns - (fe.end_ns - fe.start_ns))), 'vblank', '帧间隙', f);

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
      const gapStart_ns = t_ns;
      addLp('LP-11', Math.max(timing.vblank_ns, 400), '');
      packets.push({ kind: 'vblank', label: '帧间隙', start_ns: gapStart_ns, end_ns: t_ns, frameIndex: -1 });
    }

    return {
      ...timing,
      headBytes,
      segments,
      packets,
      frames,
      duration_ns: t_ns,
      frameCount,
      seed: opts.seed || 1,
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

    const rawIndex = Math.floor((t_ns - seg.start_ns) / seg.ui_ns);
    const bitIndex = Math.max(0, Math.min(seg.bitCount - 1, rawIndex));
    const bit = bitAt(seg, bitIndex);
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
    deriveTiming,
    bitAt,
    segmentsIn,
    packetsIn,
    describeAt,
    formatTime_ns,
    formatTick_ns,
    formatVoltage_v,
    tickStep_ns,
    findFormat,
    HS_LEVEL,
    LP_LEVEL,
    STAGE_STYLE,
    PACKET_STYLE,
    FORMATS,
    RESOLUTIONS,
    CLOCK_LANE_CHOICES_MHZ,
    LANE_CHOICES,
    FRAME_CHOICES,
  };
})(window.MIPI = window.MIPI || {});
