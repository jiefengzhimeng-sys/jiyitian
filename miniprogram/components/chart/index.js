/**
 * 轻量图表组件（Canvas 2D）
 * 支持三种形态：line 折线/面积、ring 环形、bar 柱状
 * 不引入第三方图表库，包体积 0 依赖
 */
Component({
  properties: {
    type: { type: String, value: 'line' },
    /** line/bar: [{ label, value }] */
    series: { type: Array, value: [] },
    /** ring: [{ color, percent }] */
    segments: { type: Array, value: [] },
    centerText: { type: String, value: '' },
    centerSub: { type: String, value: '' },
    /** 画布高度，单位 px */
    height: { type: Number, value: 180 },
    /** 柱状图高亮最后 N 根 */
    highlightLast: { type: Number, value: 0 }
  },

  data: {},

  observers: {
    'series, segments, centerText': function () {
      this.draw();
    }
  },

  lifetimes: {
    ready() {
      this.initCanvas();
    }
  },

  pageLifetimes: {
    show() {
      // 页面从后台回来时补一次重绘，避免 canvas 被清空
      if (this._ctx) this.draw();
    }
  },

  methods: {
    initCanvas() {
      const query = this.createSelectorQuery();
      query
        .select('.cv')
        .fields({ node: true, size: true })
        .exec(res => {
          const item = res && res[0];
          if (!item || !item.node) {
            // 布局未就绪，下一帧再试一次
            return setTimeout(() => this.initCanvas(), 60);
          }
          const node = item.node;
          const w = item.width;
          const h = item.height;
          if (!w || !h) return setTimeout(() => this.initCanvas(), 60);

          let dpr = 2;
          try {
            const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
            dpr = info.pixelRatio || 2;
          } catch (e) {}

          node.width = w * dpr;
          node.height = h * dpr;
          const ctx = node.getContext('2d');
          ctx.scale(dpr, dpr);

          this._ctx = ctx;
          this._w = w;
          this._h = h;
          this.draw();
        });
    },

    draw() {
      const ctx = this._ctx;
      if (!ctx) return;
      const w = this._w;
      const h = this._h;
      ctx.clearRect(0, 0, w, h);

      if (this.data.type === 'ring') this.drawRing(ctx, w, h);
      else if (this.data.type === 'bar') this.drawBar(ctx, w, h);
      else this.drawLine(ctx, w, h);
    },

    /* -------------------- 折线 + 面积 -------------------- */
    drawLine(ctx, w, h) {
      const data = (this.data.series || []).filter(d => typeof d.value === 'number');
      if (data.length < 2) {
        this.drawPlaceholder(ctx, w, h, '再记几天就能画出曲线');
        return;
      }

      const padL = 6;
      const padR = 10;
      const padT = 16;
      const padB = 22;
      const innerW = w - padL - padR;
      const innerH = h - padT - padB;

      const values = data.map(d => d.value);
      let max = Math.max.apply(null, values);
      let min = Math.min.apply(null, values);
      if (max === min) {
        max += 0.5;
        min -= 0.5;
      }
      const span = max - min;

      const x = i => padL + (innerW * i) / (data.length - 1);
      const y = v => padT + innerH - ((v - min) / span) * innerH;

      // 网格线
      ctx.strokeStyle = '#F0EBE0';
      ctx.lineWidth = 1;
      [0, 0.5, 1].forEach(p => {
        const gy = padT + innerH * p;
        ctx.beginPath();
        ctx.moveTo(padL, gy);
        ctx.lineTo(w - padR, gy);
        ctx.stroke();
      });

      // 面积
      const grad = ctx.createLinearGradient(0, padT, 0, padT + innerH);
      grad.addColorStop(0, 'rgba(216,244,92,0.55)');
      grad.addColorStop(1, 'rgba(216,244,92,0)');
      ctx.beginPath();
      ctx.moveTo(x(0), y(values[0]));
      data.forEach((d, i) => ctx.lineTo(x(i), y(d.value)));
      ctx.lineTo(x(data.length - 1), padT + innerH);
      ctx.lineTo(x(0), padT + innerH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // 折线
      ctx.beginPath();
      ctx.moveTo(x(0), y(values[0]));
      data.forEach((d, i) => ctx.lineTo(x(i), y(d.value)));
      ctx.strokeStyle = '#17161A';
      ctx.lineWidth = 2.4;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();

      // 节点：中间的用空心，最后一个用青柠实心
      data.forEach((d, i) => {
        if (i === 0 || i === data.length - 1) return;
        if (data.length > 6 && i % 2 !== 0) return;
        ctx.beginPath();
        ctx.arc(x(i), y(d.value), 3, 0, Math.PI * 2);
        ctx.fillStyle = '#FFFFFF';
        ctx.fill();
        ctx.strokeStyle = '#17161A';
        ctx.lineWidth = 2;
        ctx.stroke();
      });

      ctx.beginPath();
      ctx.arc(x(data.length - 1), y(values[data.length - 1]), 4.5, 0, Math.PI * 2);
      ctx.fillStyle = '#D8F45C';
      ctx.fill();
      ctx.strokeStyle = '#17161A';
      ctx.lineWidth = 2.2;
      ctx.stroke();

      // 横轴标签
      ctx.fillStyle = '#8E8B96';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const step = Math.max(1, Math.floor(data.length / 4));
      data.forEach((d, i) => {
        if (i % step !== 0 && i !== data.length - 1) return;
        ctx.fillText(d.label || '', x(i), h - 6);
      });

      // 末值标注
      ctx.fillStyle = '#17161A';
      ctx.font = 'bold 9px ui-monospace, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(values[values.length - 1]), w - padR, y(values[values.length - 1]) - 9);
    },

    /* -------------------- 环形 -------------------- */
    drawRing(ctx, w, h) {
      const segs = (this.data.segments || []).filter(s => s.percent > 0);
      const cx = w / 2;
      const cy = h / 2;
      const r = Math.min(w, h) / 2 - 8;
      const lineW = 10;

      // 底环
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = '#F0EBE0';
      ctx.lineWidth = lineW;
      ctx.stroke();

      if (!segs.length) {
        this.drawPlaceholder(ctx, w, h, '还没有情绪记录');
        return;
      }

      let start = -Math.PI / 2;
      segs.forEach(s => {
        const angle = (s.percent / 100) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, start + 0.03, start + angle - 0.03);
        ctx.strokeStyle = s.color || '#17161A';
        ctx.lineWidth = lineW;
        ctx.lineCap = 'round';
        ctx.stroke();
        start += angle;
      });

      // 中心文字
      if (this.data.centerText) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#17161A';
        ctx.font = 'bold 15px ui-monospace, monospace';
        ctx.fillText(this.data.centerText, cx, cy + 2);
      }
      if (this.data.centerSub) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#8E8B96';
        ctx.font = '9px -apple-system, sans-serif';
        ctx.fillText(this.data.centerSub, cx, cy + 16);
      }
    },

    /* -------------------- 柱状 -------------------- */
    drawBar(ctx, w, h) {
      const data = this.data.series || [];
      if (!data.length) {
        this.drawPlaceholder(ctx, w, h, '暂无数据');
        return;
      }
      const padB = 18;
      const innerH = h - padB;
      const n = data.length;
      const gap = 8;
      const barW = (w - gap * (n - 1)) / n;
      const max = Math.max.apply(null, data.map(d => d.value).concat([1]));
      const hlFrom = this.data.highlightLast ? n - this.data.highlightLast : n;

      data.forEach((d, i) => {
        const bh = Math.max((d.value / max) * (innerH - 6), d.value > 0 ? 6 : 4);
        const bx = i * (barW + gap);
        const by = innerH - bh;
        const active = i >= hlFrom || d.value === max;

        ctx.beginPath();
        const rr = Math.min(barW / 2, 5);
        this.roundRect(ctx, bx, by, barW, bh, rr);
        if (active) {
          const g2 = ctx.createLinearGradient(0, by, 0, innerH);
          g2.addColorStop(0, '#D8F45C');
          g2.addColorStop(1, '#B9D62F');
          ctx.fillStyle = g2;
        } else {
          ctx.fillStyle = '#F2EBDF';
        }
        ctx.fill();

        ctx.fillStyle = '#8E8B96';
        ctx.font = '8px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(d.label || '', bx + barW / 2, h - 4);
      });
    },

    roundRect(ctx, x, y, w, h, r) {
      const rr = Math.min(r, w / 2, h / 2);
      ctx.moveTo(x + rr, y);
      ctx.lineTo(x + w - rr, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
      ctx.lineTo(x + w, y + h);
      ctx.lineTo(x, y + h);
      ctx.lineTo(x, y + rr);
      ctx.quadraticCurveTo(x, y, x + rr, y);
    },

    drawPlaceholder(ctx, w, h, text) {
      ctx.fillStyle = '#8E8B96';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(text, w / 2, h / 2);
    }
  }
});
