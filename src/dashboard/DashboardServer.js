/**
 * DashboardServer
 * ================
 * Express 服务器,提供:
 *   - GET  /api/stats            24h 统计
 *   - GET  /api/tokens           当前监控池
 *   - GET  /api/trades?limit=50  最近交易
 *   - GET  /api/signals?limit=50 最近信号
 *   - GET  /api/positions        当前持仓
 *   - POST /api/tokens           手动添加 token
 *   - DELETE /api/tokens/:addr   手动移除
 *   - POST /webhook/add-token    webhook(对齐你的 curl 格式)
 *   - GET  /api/reports          报告列表
 *   - GET  /api/reports/:date    单日报告
 * 静态文件:public/index.html (dashboard UI)
 */
const express = require('express');
const path = require('path');
const fs = require('fs');

class DashboardServer {
  constructor(opts) {
    this.port = opts.port;
    this.tokenPool = opts.tokenPool;
    this.orchestrator = opts.orchestrator;
    this.tradeLogger = opts.tradeLogger;
    this.app = express();
    this.server = null;
    this._setupRoutes();
  }

  _setupRoutes() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, '..', '..', 'public')));

    // ========== API ==========
    this.app.get('/api/stats', (req, res) => {
      const stats = this.tradeLogger.get24hStats();
      res.json({
        ok: true,
        ...stats,
        tokenCount: this.tokenPool.getAll().length,
        positionCount: this.orchestrator.getPositions().length,
        signalCount: this.tradeLogger.recentSignals.length,
      });
    });

    this.app.get('/api/tokens', (req, res) => {
      const tokens = this.tokenPool.getAll().map(t => {
        const pos = this.orchestrator.getPositions().find(p => p.tokenMeta.address === t.address);
        return {
          ...t,
          hasPosition: !!pos,
        };
      });
      res.json({ ok: true, tokens });
    });

    this.app.get('/api/trades', (req, res) => {
      const limit = parseInt(req.query.limit || 50);
      res.json({ ok: true, trades: this.tradeLogger.getRecentTrades(limit) });
    });

    this.app.get('/api/signals', (req, res) => {
      const limit = parseInt(req.query.limit || 100);
      res.json({ ok: true, signals: this.tradeLogger.getRecentSignals(limit) });
    });

    this.app.get('/api/positions', (req, res) => {
      res.json({ ok: true, positions: this.orchestrator.getPositions() });
    });

    this.app.post('/api/tokens', async (req, res) => {
      try {
        const result = await this.tokenPool.addToken(req.body);
        res.json({ ok: true, ...result });
      } catch (e) {
        res.status(400).json({ ok: false, error: e.message });
      }
    });

    this.app.delete('/api/tokens/:address', (req, res) => {
      const ok = this.tokenPool.removeToken(req.params.address, 'MANUAL');
      res.json({ ok });
    });

    // ========== Webhook(对齐你的 curl)==========
    // curl -X POST http://server:3001/webhook/add-token \
    //   -H "Content-Type: application/json" \
    //   -d '{"network":"solana","address":"...","symbol":"Nana"}'
    this.app.post('/webhook/add-token', async (req, res) => {
      try {
        const result = await this.tokenPool.addToken(req.body);
        console.log(`[WEBHOOK] addToken: ${req.body.symbol || req.body.address}`);
        res.json({ ok: true, ...result });
      } catch (e) {
        console.error('[WEBHOOK] addToken error:', e.message);
        res.status(400).json({ ok: false, error: e.message });
      }
    });

    // ========== 报告 ==========
    this.app.get('/api/reports', (req, res) => {
      const reportDir = path.join(__dirname, '..', '..', 'data', 'reports');
      if (!fs.existsSync(reportDir)) {
        return res.json({ ok: true, reports: [] });
      }
      const files = fs.readdirSync(reportDir).filter(f => f.endsWith('.json')).sort().reverse();
      res.json({ ok: true, reports: files });
    });

    this.app.get('/api/reports/:date', (req, res) => {
      const reportDir = path.join(__dirname, '..', '..', 'data', 'reports');
      const file = path.join(reportDir, `${req.params.date}.json`);
      if (!fs.existsSync(file)) {
        return res.status(404).json({ ok: false, error: 'not found' });
      }
      res.json(JSON.parse(fs.readFileSync(file, 'utf-8')));
    });

    this.app.get('/api/reports/:date/csv', (req, res) => {
      const reportDir = path.join(__dirname, '..', '..', 'data', 'reports');
      const file = path.join(reportDir, `${req.params.date}.csv`);
      if (!fs.existsSync(file)) {
        return res.status(404).send('not found');
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${req.params.date}.csv"`);
      res.send(fs.readFileSync(file));
    });
  }

  async start() {
    return new Promise((resolve) => {
      this.server = this.app.listen(this.port, () => {
        console.log(`[DASH] http://localhost:${this.port}`);
        resolve();
      });
    });
  }

  async stop() {
    return new Promise((resolve) => {
      if (this.server) this.server.close(resolve);
      else resolve();
    });
  }
}

module.exports = DashboardServer;
