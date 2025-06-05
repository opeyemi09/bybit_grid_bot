/**
 * Profitable Bybit Grid Trading Bot with Automatic Rebalancing and Telegram Alerts
 * - Implements grid trading strategy with auto grid rebalancing based on volatility and price deviation.
 * - Sends Telegram alerts for all buy/sell order activities.
 * - RESTful API for bot control and monitoring.
 * 
 * Place this file at your project root and install dependencies:
 * npm install bybit-api node-fetch express cors dotenv
 */

import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import BybitAPI from "bybit-api"
import fetch from "node-fetch"
import express from "express"
import cors from "cors"
import dotenv from 'dotenv'
dotenv.config()
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// Data persistence paths
const DATA_DIR = path.join(__dirname, "data")
const TRADES_FILE = path.join(DATA_DIR, "trades.json")
const PERFORMANCE_FILE = path.join(DATA_DIR, "performance.json")
const STATE_FILE = path.join(DATA_DIR, "bot_state.json")

// --- CONFIGURATION ---
const CONFIG = {
  BYBIT_API_KEY: process.env.BYBIT_API_KEY,
  BYBIT_SECRET: process.env.BYBIT_SECRET,
  BYBIT_BASE_URL: "https://api.bybit.com",
  BYBIT_TESTNET: false,

  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,

  SYMBOL: "BTCUSDT",
  BASE_INVESTMENT: 1000,       // Total investment in USDT
  GRID_LEVELS: 12,             // Number of grid levels
  GRID_SPACING: 0.007,         // Default grid spacing (0.7%)
  ATR_PERIOD: 14,              // ATR periods for dynamic grid
  ATR_MULTIPLIER: 1.7,         // ATR range for grid
  MIN_GRID_SPACING: 0.004,     // Min spacing (0.4%)
  MAX_GRID_SPACING: 0.025,     // Max spacing (2.5%)
  REBALANCE_THRESHOLD: 0.075,  // % deviation from center to trigger rebalance
  DCA_PERCENTAGE: 0.018,       // DCA threshold (1.8%)
  MAX_POSITION_SIZE: 0.09,     // 9% of portfolio per grid level
  STOP_LOSS_PERCENTAGE: 0.035, // 3.5%
  TAKE_PROFIT_PERCENTAGE: 0.018, // 1.8%
  MAX_DAILY_TRADES: 50,
  VOLATILITY_THRESHOLD: 0.018, // 1.8% daily volatility triggers rebalance

  ORDER_CHECK_INTERVAL: 3500,
  PRICE_UPDATE_INTERVAL: 2500,
  REBALANCE_COOLDOWN: 1800000,

  WEB_PORT: 3001
}

// -- Utilities --
class DataPersistence {
  constructor() { this.ensureDataDirectory() }
  async ensureDataDirectory() { await fs.mkdir(DATA_DIR, { recursive: true }).catch(()=>{}) }
  async saveData(filename, data) { await fs.writeFile(filename, JSON.stringify(data, null, 2)).catch(()=>{}) }
  async loadData(filename, defaultData = {}) {
    try { return JSON.parse(await fs.readFile(filename, "utf8")) }
    catch (e) { await this.saveData(filename, defaultData); return defaultData }
  }
  async saveTrade(trade) {
    const trades = await this.loadData(TRADES_FILE, [])
    trades.push({ ...trade, timestamp: Date.now(), id: crypto.randomUUID() })
    if (trades.length > 1000) trades.splice(0, trades.length - 1000)
    await this.saveData(TRADES_FILE, trades)
  }
  async savePerformance(perf) { await this.saveData(PERFORMANCE_FILE, { ...perf, lastUpdated: Date.now() }) }
  async saveBotState(state) { await this.saveData(STATE_FILE, { ...state, lastUpdated: Date.now() }) }
}

class ProfitableGridTradingBot {
  constructor() {
    this.orders = new Map()
    this.gridLevels = []
    this.currentPrice = 0
    this.atr = 0
    this.isRunning = false
    this.lastRebalance = Date.now()
    this.priceHistory = []
    this.dailyTrades = 0
    this.lastTradeReset = Date.now()
    this.marketCondition = "SIDEWAYS"
    this.profitLoss = 0
    this.totalTrades = 0
    this.successfulTrades = 0
    this.priceChangeBuffer = []
    this.volatilityIndex = 0
    this.startTime = Date.now()

    this.bybitClient = new BybitAPI.RestClientV5({
      key: CONFIG.BYBIT_API_KEY,
      secret: CONFIG.BYBIT_SECRET,
      testnet: CONFIG.BYBIT_TESTNET,
    })
    this.dataManager = new DataPersistence()
    this.performance = {
      totalProfit: 0, totalLoss: 0, winRate: 0, maxDrawdown: 0,
      sharpeRatio: 0, dailyReturns: [], totalVolume: 0,
      avgTradeSize: 0, bestTrade: 0, worstTrade: 0, profitFactor: 0,
    }
    this.loadSavedData()
  }

  async loadSavedData() {
    const savedState = await this.dataManager.loadData(STATE_FILE, {})
    const savedPerformance = await this.dataManager.loadData(PERFORMANCE_FILE, {})
    if (savedState.profitLoss !== undefined) {
      this.profitLoss = savedState.profitLoss
      this.totalTrades = savedState.totalTrades || 0
      this.successfulTrades = savedState.successfulTrades || 0
      this.dailyTrades = savedState.dailyTrades || 0
    }
    if (Object.keys(savedPerformance).length > 0) {
      this.performance = { ...this.performance, ...savedPerformance }
    }
  }

  // -- Price/ATR/Volatility --
  async getCurrentPrice() {
    try {
      const resp = await this.bybitClient.getTickers({ category: "spot", symbol: CONFIG.SYMBOL })
      if (resp.retCode === 0 && resp.result.list && resp.result.list.length > 0) {
        const newPrice = Number.parseFloat(resp.result.list[0].lastPrice)
        if (this.currentPrice > 0) {
          const priceChange = (newPrice - this.currentPrice) / this.currentPrice
          this.priceChangeBuffer.push(priceChange)
          if (this.priceChangeBuffer.length > 20) this.priceChangeBuffer.shift()
        }
        this.currentPrice = newPrice
        this.priceHistory.push(newPrice)
        if (this.priceHistory.length > 200) this.priceHistory.shift()
        return this.currentPrice
      } else { throw new Error("Invalid price data") }
    } catch (e) { throw e }
  }

  async calculateATR() {
    const resp = await this.bybitClient.getKline({
      category: "spot", symbol: CONFIG.SYMBOL, interval: "15", limit: CONFIG.ATR_PERIOD + 1
    })
    if (resp.retCode === 0 && resp.result.list && resp.result.list.length > CONFIG.ATR_PERIOD) {
      const klines = resp.result.list.reverse()
      let trSum = 0
      for (let i = 1; i < klines.length; i++) {
        const high = Number.parseFloat(klines[i][2])
        const low = Number.parseFloat(klines[i][3])
        const prevClose = Number.parseFloat(klines[i-1][4])
        const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
        trSum += tr
      }
      this.atr = trSum / CONFIG.ATR_PERIOD
      this.calculateVolatilityIndex()
      return this.atr
    } else throw new Error("Invalid ATR data")
  }

  calculateVolatilityIndex() {
    if (this.priceChangeBuffer.length < 10) return
    const variance = this.priceChangeBuffer.reduce((sum, ch)=>
      sum + Math.pow(ch, 2), 0) / this.priceChangeBuffer.length
    this.volatilityIndex = Math.sqrt(variance)
  }

  detectMarketCondition() {
    if (this.priceHistory.length < 20) return "UNKNOWN"
    const recent = this.priceHistory.slice(-10)
    const older = this.priceHistory.slice(-20, -10)
    const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length
    const olderAvg = older.reduce((a, b) => a + b, 0) / older.length
    const momentum = (recentAvg - olderAvg) / olderAvg
    if (momentum > 0.02 && this.volatilityIndex < CONFIG.VOLATILITY_THRESHOLD) this.marketCondition = "BULL"
    else if (momentum < -0.02 && this.volatilityIndex < CONFIG.VOLATILITY_THRESHOLD) this.marketCondition = "BEAR"
    else if (this.volatilityIndex > CONFIG.VOLATILITY_THRESHOLD) this.marketCondition = "VOLATILE"
    else this.marketCondition = "SIDEWAYS"
    return this.marketCondition
  }

  // -- Grid --
  calculateDynamicGridSpacing() {
    if (!this.atr || !this.currentPrice) return CONFIG.GRID_SPACING
    let spacing = Math.max(CONFIG.MIN_GRID_SPACING, Math.min(CONFIG.MAX_GRID_SPACING, (this.atr/this.currentPrice)*0.8))
    switch (this.marketCondition) {
      case "BULL": spacing *= 1.2; break
      case "BEAR": spacing *= 0.9; break
      case "VOLATILE": spacing *= 1.5; break
      case "SIDEWAYS": spacing *= 1; break
    }
    return Math.max(CONFIG.MIN_GRID_SPACING, Math.min(CONFIG.MAX_GRID_SPACING, spacing))
  }

  generateGridLevels() {
    const spacing = this.calculateDynamicGridSpacing()
    const centerPrice = this.currentPrice
    const atrRange = this.atr * CONFIG.ATR_MULTIPLIER
    this.gridLevels = []
    const upperBound = centerPrice + atrRange
    const lowerBound = centerPrice - atrRange
    const priceRange = upperBound - lowerBound
    const levelSpacing = priceRange / CONFIG.GRID_LEVELS
    for (let i = 0; i < CONFIG.GRID_LEVELS; i++) {
      const buyPrice = lowerBound + levelSpacing * i
      const sellPrice = buyPrice * (1 + spacing)
      const quantity = this.calculateOrderQuantity(buyPrice)
      const priceDistance = Math.abs(buyPrice - centerPrice) / centerPrice
      if (priceDistance < spacing * 0.5) continue
      this.gridLevels.push({
        level: i,
        buyPrice: Number.parseFloat(buyPrice.toFixed(6)),
        sellPrice: Number.parseFloat(sellPrice.toFixed(6)),
        quantity: Number.parseFloat(quantity.toFixed(8)),
        active: false,
        priceDistance,
      })
    }
    this.gridLevels.sort((a, b) => a.priceDistance - b.priceDistance)
    return this.gridLevels
  }

  calculateOrderQuantity(price) {
    const baseQuantity = CONFIG.BASE_INVESTMENT / CONFIG.GRID_LEVELS / price
    const maxQuantity = (CONFIG.BASE_INVESTMENT * CONFIG.MAX_POSITION_SIZE) / price
    let adjustedQuantity = Math.min(baseQuantity, maxQuantity)
    switch (this.marketCondition) {
      case "VOLATILE": adjustedQuantity *= 0.7; break
      case "BULL": adjustedQuantity *= 1.1; break
      case "BEAR": adjustedQuantity *= 0.9; break
    }
    return Math.max(adjustedQuantity, 0.001)
  }

  // -- Trades + Telegram --
  async placeBuyOrder(price, quantity, orderType = "Limit") {
    if (this.dailyTrades >= CONFIG.MAX_DAILY_TRADES) return null
    try {
      const params = {
        category: "spot", symbol: CONFIG.SYMBOL, side: "Buy",
        orderType, qty: quantity.toString(), price: price.toString(), timeInForce: "GTC",
      }
      const resp = await this.bybitClient.submitOrder(params)
      if (resp.retCode === 0) {
        this.dailyTrades++
        await this.dataManager.saveTrade({
          type: "buy_order_placed", symbol: CONFIG.SYMBOL, price, quantity,
          orderId: resp.result.orderId, marketCondition: this.marketCondition,
        })
        await this.sendTelegramAlert(`🟩 BUY ORDER: <b>${quantity}</b> ${CONFIG.SYMBOL} @ <b>$${price}</b>`)
        return resp.result
      } else throw new Error(resp.retMsg)
    } catch (error) {
      await this.sendTelegramAlert(`❗️ BUY ORDER FAILED: ${error.message}`)
      return null
    }
  }

  async placeSellOrder(price, quantity, orderType = "Limit") {
    if (this.dailyTrades >= CONFIG.MAX_DAILY_TRADES) return null
    try {
      const params = {
        category: "spot", symbol: CONFIG.SYMBOL, side: "Sell",
        orderType, qty: quantity.toString(), price: price.toString(), timeInForce: "GTC",
      }
      const resp = await this.bybitClient.submitOrder(params)
      if (resp.retCode === 0) {
        this.dailyTrades++
        await this.dataManager.saveTrade({
          type: "sell_order_placed", symbol: CONFIG.SYMBOL, price, quantity,
          orderId: resp.result.orderId, marketCondition: this.marketCondition,
        })
        await this.sendTelegramAlert(`🟥 SELL ORDER: <b>${quantity}</b> ${CONFIG.SYMBOL} @ <b>$${price}</b>`)
        return resp.result
      } else throw new Error(resp.retMsg)
    } catch (error) {
      await this.sendTelegramAlert(`❗️ SELL ORDER FAILED: ${error.message}`)
      return null
    }
  }

  async handleFilledOrder(orderInfo, filledOrder) {
    this.totalTrades++
    const executedPrice = Number.parseFloat(filledOrder.price || filledOrder.avgPrice)
    const executedQty = Number.parseFloat(filledOrder.qty || filledOrder.cumExecQty)
    let profit = 0
    if (orderInfo.type === "sell") {
      profit = (executedPrice - orderInfo.buyPrice) * executedQty
      this.profitLoss += profit
      this.performance.totalProfit += Math.max(0, profit)
      this.performance.totalLoss += Math.max(0, -profit)
      this.successfulTrades += profit > 0 ? 1 : 0
      this.performance.bestTrade = Math.max(this.performance.bestTrade, profit)
      this.performance.worstTrade = Math.min(this.performance.worstTrade, profit)
    }
    this.performance.totalVolume += executedPrice * executedQty
    this.performance.avgTradeSize = this.performance.totalVolume / this.totalTrades
    this.performance.winRate = (this.successfulTrades / this.totalTrades) * 100
    if (this.performance.totalLoss > 0) {
      this.performance.profitFactor = this.performance.totalProfit / this.performance.totalLoss
    }
    await this.dataManager.saveTrade({
      type: "order_filled", side: orderInfo.type, symbol: CONFIG.SYMBOL,
      price: executedPrice, quantity: executedQty, profit, orderId: filledOrder.orderId || filledOrder.order_id,
      marketCondition: this.marketCondition, totalPnL: this.profitLoss,
    })
    await this.saveCurrentState()
    await this.sendTelegramAlert(
      `✅ <b>Order filled:</b> ${orderInfo.type.toUpperCase()} <b>${executedQty}</b> @ <b>$${executedPrice}</b>\nP&L: <b>$${profit.toFixed(2)}</b>`
    )
  }

  async sendTelegramAlert(message) {
    try {
      if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) return
      const url = `https://api.telegram.org/bot${CONFIG.TELEGRAM_BOT_TOKEN}/sendMessage`
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CONFIG.TELEGRAM_CHAT_ID,
          text: message,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
      })
      const data = await resp.json()
      if (!data.ok) console.error("Telegram error:", data.description)
    } catch (error) { console.error("Error sending Telegram:", error.message) }
  }

  // -- Order Monitor / Control --
  async monitorOrders() {
    try {
      const resp = await this.bybitClient.getActiveOrders({ category: "spot", symbol: CONFIG.SYMBOL })
      if (resp.retCode === 0) {
        const activeOrders = resp.result.list || []
        for (const [orderId, orderInfo] of this.orders.entries()) {
          const activeOrder = activeOrders.find((o) => o.orderId === orderId)
          if (!activeOrder) {
            const filledOrder = await this.checkOrderStatus(orderId)
            if (filledOrder && filledOrder.orderStatus === "Filled") {
              await this.handleFilledOrder(orderInfo, filledOrder)
              this.orders.delete(orderId)
            }
          }
        }
      }
    } catch (error) { }
  }

  async checkOrderStatus(orderId) {
    try {
      const resp = await this.bybitClient.getOrderHistory({ category: "spot", symbol: CONFIG.SYMBOL, orderId })
      if (resp.retCode === 0 && resp.result.list && resp.result.list.length > 0) {
        return resp.result.list[0]
      }
    } catch (error) { }
    return null
  }

  async placeGridOrders() {
    let placedOrders = 0
    const maxConcurrentOrders = Math.min(CONFIG.GRID_LEVELS, 20)
    for (const level of this.gridLevels.slice(0, maxConcurrentOrders)) {
      try {
        if (level.buyPrice < this.currentPrice * 0.995) {
          const buyOrder = await this.placeBuyOrder(level.buyPrice, level.quantity)
          if (buyOrder) {
            this.orders.set(buyOrder.orderId, {
              ...level, type: "buy", orderId: buyOrder.orderId, timestamp: Date.now(),
            })
            placedOrders++
          }
        }
        if (level.sellPrice > this.currentPrice * 1.005) {
          const sellOrder = await this.placeSellOrder(level.sellPrice, level.quantity)
          if (sellOrder) {
            this.orders.set(sellOrder.orderId, {
              ...level, type: "sell", orderId: sellOrder.orderId, timestamp: Date.now(),
            })
            placedOrders++
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 200))
      } catch (error) { }
    }
    return placedOrders
  }

  async cancelAllOrders() {
    try {
      const resp = await this.bybitClient.cancelAllOrders({ category: "spot", symbol: CONFIG.SYMBOL })
      if (resp.retCode === 0) {
        this.orders.clear()
        await this.sendTelegramAlert("❕ All grid orders cancelled.")
        return true
      }
    } catch (error) { }
    return false
  }

  resetDailyTrades() {
    if (Date.now() - this.lastTradeReset > 86400000) {
      this.dailyTrades = 0
      this.lastTradeReset = Date.now()
    }
  }

  // -- DCA & Rebalance --
  async executeDCA() {
    const priceDropThreshold = this.currentPrice * (1 - CONFIG.DCA_PERCENTAGE)
    const recentLow = Math.min(...this.priceHistory.slice(-5))
    if (recentLow <= priceDropThreshold && (this.marketCondition === "SIDEWAYS" || this.marketCondition === "BULL")) {
      const dcaQuantity = this.calculateOrderQuantity(this.currentPrice) * 0.6
      const dcaPrice = this.currentPrice * 0.999
      const order = await this.placeBuyOrder(dcaPrice, dcaQuantity)
      if (order) await this.sendTelegramAlert(`🔄 DCA executed at $${this.currentPrice}`)
    }
  }

  async rebalanceGrid() {
    const now = Date.now()
    const timeSinceLastRebalance = now - this.lastRebalance
    if (timeSinceLastRebalance < CONFIG.REBALANCE_COOLDOWN) return
    const centerLevel = this.gridLevels[Math.floor(this.gridLevels.length/2)]
    if (!centerLevel) return
    const priceDeviation = Math.abs(this.currentPrice - centerLevel.buyPrice) / this.currentPrice
    const shouldRebalance =
      priceDeviation > CONFIG.REBALANCE_THRESHOLD ||
      this.volatilityIndex > CONFIG.VOLATILITY_THRESHOLD * 1.5 ||
      this.orders.size < CONFIG.GRID_LEVELS * 0.3
    if (shouldRebalance) {
      await this.sendTelegramAlert(
        `🔄 <b>Rebalancing grid</b> - Deviation: <b>${(priceDeviation*100).toFixed(2)}%</b>\nVolatility: <b>${(this.volatilityIndex*100).toFixed(2)}%</b>`
      )
      await this.cancelAllOrders()
      await new Promise((resolve) => setTimeout(resolve, 2000))
      this.detectMarketCondition()
      await this.calculateATR()
      this.generateGridLevels()
      await this.placeGridOrders()
      this.lastRebalance = now
      await this.saveCurrentState()
    }
  }

  async saveCurrentState() {
    const state = {
      profitLoss: this.profitLoss, totalTrades: this.totalTrades, successfulTrades: this.successfulTrades,
      dailyTrades: this.dailyTrades, currentPrice: this.currentPrice, marketCondition: this.marketCondition,
      volatilityIndex: this.volatilityIndex, atr: this.atr, activeOrders: this.orders.size,
      gridLevels: this.gridLevels.length, isRunning: this.isRunning, uptime: Date.now() - this.startTime,
    }
    await this.dataManager.saveBotState(state)
    await this.dataManager.savePerformance(this.performance)
  }

  // -- Web API --
  getApiData() {
    return {
      status: {
        isRunning: this.isRunning,
        currentPrice: this.currentPrice,
        marketCondition: this.marketCondition,
        volatilityIndex: this.volatilityIndex,
        atr: this.atr,
        uptime: Date.now() - this.startTime
      },
      trading: {
        profitLoss: this.profitLoss,
        totalTrades: this.totalTrades,
        successfulTrades: this.successfulTrades,
        dailyTrades: this.dailyTrades,
        maxDailyTrades: CONFIG.MAX_DAILY_TRADES,
        activeOrders: this.orders.size,
        gridLevels: this.gridLevels.length,
      },
      performance: this.performance,
      grid: {
        levels: this.gridLevels,
        spacing: this.calculateDynamicGridSpacing(),
        investment: CONFIG.BASE_INVESTMENT,
      },
      priceHistory: this.priceHistory.slice(-50),
    }
  }

  // -- Main Loop --
  async start() {
    if (!CONFIG.BYBIT_API_KEY || !CONFIG.BYBIT_SECRET) throw new Error("Bybit API credentials not found!")
    this.isRunning = true
    let loopCount = 0
    await this.sendTelegramAlert("🚀 Profitable Grid Trading Bot started.")
    while (this.isRunning) {
      try {
        loopCount++
        await this.getCurrentPrice()
        if (!this.currentPrice) { await new Promise(r => setTimeout(r, 5000)); continue }
        await this.calculateATR()
        this.detectMarketCondition()
        this.resetDailyTrades()
        if (this.gridLevels.length === 0) {
          this.generateGridLevels()
          await this.placeGridOrders()
        }
        await this.monitorOrders()
        await this.executeDCA()
        await this.rebalanceGrid()
        if (loopCount % 12 === 0) await this.saveCurrentState()
        if (loopCount % 30 === 0)
          console.log(
            `📊 Price: $${this.currentPrice.toFixed(2)} | Market: ${this.marketCondition} | P&L: $${this.profitLoss.toFixed(2)} | Orders: ${this.orders.size}`,
          )
        await new Promise((resolve) => setTimeout(resolve, CONFIG.PRICE_UPDATE_INTERVAL))
      } catch (error) {
        console.error("❌ Error in main loop:", error.message)
        await this.sendTelegramAlert(`❗️ Bot error: ${error.message}`)
        await new Promise((resolve) => setTimeout(resolve, 10000))
      }
    }
  }

  async stop() {
    this.isRunning = false
    await this.cancelAllOrders()
    await this.saveCurrentState()
    await this.sendTelegramAlert("🛑 Grid Trading Bot stopped.")
  }
}

// --- Express RESTful API Server ---
async function main() {
  const gridBot = new ProfitableGridTradingBot()
  const app = express()
  app.use(cors())
  app.use(express.json())

  app.get("/api/status", (req, res) => res.json(gridBot.getApiData()))
  app.get("/api/trades", async (req, res) => {
    const limit = parseInt(req.query.limit) || 100
    const offset = parseInt(req.query.offset) || 0
    const allTrades = await gridBot.dataManager.loadData(TRADES_FILE, [])
    const paginated = allTrades.slice(offset, offset + limit)
    res.json({ trades: paginated, total: allTrades.length, limit, offset })
  })
  app.get("/api/performance", (req, res) => res.json(gridBot.performance))
  app.get("/api/grid", (req, res) => res.json({
    gridLevels: gridBot.gridLevels,
    config: {
      symbol: CONFIG.SYMBOL,
      baseInvestment: CONFIG.BASE_INVESTMENT,
      gridLevels: CONFIG.GRID_LEVELS,
      minSpacing: CONFIG.MIN_GRID_SPACING,
      maxSpacing: CONFIG.MAX_GRID_SPACING
    }
  }))
  app.get("/api/config", (req, res) => res.json(CONFIG))
  app.put("/api/config", async (req, res) => {
    const updates = req.body || {}
    Object.assign(CONFIG, updates)
    res.json({ success: true, updated: Object.keys(updates) })
  })
  app.post("/api/control", async (req, res) => {
    const { action } = req.body; let msg = ""
    switch (action) {
      case "start":
        if (!gridBot.isRunning) { gridBot.start(); msg = "Bot started" }
        else msg = "Bot already running"
        break
      case "stop":
        if (gridBot.isRunning) { await gridBot.stop(); msg = "Bot stopped" }
        else msg = "Bot not running"
        break
      case "rebalance":
        await gridBot.rebalanceGrid(); msg = "Grid rebalanced"
        break
      case "cancel_orders":
        await gridBot.cancelAllOrders(); msg = "All orders cancelled"
        break
      default: msg = "Unknown action"
    }
    res.json({ success: true, message: msg })
  })
  app.get("/api/orders", (req, res) => {
    const orders = Array.from(gridBot.orders.entries()).map(([orderId, info]) => ({
      orderId, ...info, age: Date.now() - info.timestamp
    }))
    res.json({ orders, total: orders.length })
  })
  app.get("/health", (req, res) => res.json({
    status: "healthy", timestamp: new Date().toISOString(), uptime: Date.now() - gridBot.startTime
  }))

  app.listen(CONFIG.WEB_PORT, () => {
    console.log(`🌐 API server at http://localhost:${CONFIG.WEB_PORT}`)
    console.log(`Endpoints: GET /api/status, /api/trades, /api/performance, /api/grid, /api/config, /api/orders, POST /api/control, PUT /api/config, GET /health`)
  })

  gridBot.start().catch((error) => {
    console.error("💥 Fatal error:", error)
    process.exit(1)
  })

  // Graceful shutdown
  const shutdown = async (signal) => {
    console.log(`\n🛑 Received ${signal}, shutting down gracefully...`)
    await gridBot.stop()
    process.exit(0)
  }
  process.on("SIGINT", () => shutdown("SIGINT"))
  process.on("SIGTERM", () => shutdown("SIGTERM"))
}

main().catch(console.error)
