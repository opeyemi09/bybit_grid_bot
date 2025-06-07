import express from "express";
import fs from "fs";
import axios from "axios";
import crypto from "crypto";
import * as ta from "technicalindicators";
import cors from "cors"
import dotenv from 'dotenv'
dotenv.config()

import TelegramBot from "node-telegram-bot-api";

// --- Order utilities ---


async function placeOrder({
  symbol,
  side,
  qty,
  apiKey,
  apiSecret,
  baseUrl = "https://api.bybit.com"
}) {
  const endpoint = "/v5/order/create";
  const url = `${baseUrl}${endpoint}`;

  const timestamp = Date.now().toString();
  const recvWindow = "60000";

  const body = {
    category: "linear",
    symbol,
    side: side.toUpperCase(),
    orderType: "MARKET",
    qty: qty.toString()
  };

  const bodyStr = JSON.stringify(body);

  const originString = timestamp + apiKey + recvWindow + bodyStr;
  const sign = crypto.createHmac("sha256", apiSecret).update(originString).digest("hex");

  const headers = {
    "X-BAPI-API-KEY": apiKey,
    "X-BAPI-TIMESTAMP": timestamp,
    "X-BAPI-RECV-WINDOW": recvWindow,
    "X-BAPI-SIGN": sign,
    "Content-Type": "application/json"
  };

  try {
    const response = await axios.post(url, body, { headers });
    if (response.data.retCode !== 0) {
      throw new Error(response.data.retMsg || "Bybit API error");
    }
    return response.data.result;
  } catch (error) {
    if (error.response) {
      throw new Error(
        `Bybit API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`
      );
    }
    throw new Error(`Network error: ${error.message}`);
  }
}

async function closeOrder({symbol, openSide, qty, apiKey, apiSecret, baseUrl = "https://api.bybit.com"}) {
  const closeSide = openSide.toUpperCase() === "BUY" ? "SELL" : "BUY";
  return placeOrder({symbol, side: closeSide, qty, apiKey, apiSecret, baseUrl});
}







// --- Bot logic ---
const app = express();
app.use(express.json());

const DATA_DIR = "./data";
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const configPath = "./config.json";
let config;
try {
  config = fs.existsSync(configPath)
    ? JSON.parse(fs.readFileSync(configPath, "utf8"))
    : {
        SYMBOLS: {
          "BTCUSDT": {
            GRID_TRAIL_THRESHOLD: 0.01,
            CAPITAL: 1000,
            RISK_PERCENT: 1,
            LEVERAGE: 5,
            GRID_STEPS: 5,
            GRID_SPACING: 0.003,
            FEE_PERCENT: 0.0002,
            TIMEFRAME: "1",
            // Hedging and protection parameters
            HEDGE_LOSS_PERCENT: 8,       // Hedge at 5% loss
            HEDGE_TP_PERCENT: 10,         // Hedge TP at 8%
            HEDGE_SL_PERCENT: 5,         // Hedge SL at 2%
            MAIN_TP_PERCENT: 50,         // Main position TP at 50%
            MAIN_PROTECTION_START: 20,   // Start protecting at 20% profit
            MAIN_PROTECTION_PERCENT: 10  // Protection SL at 10%
          }
        },
        BASE_INVESTMENT: 10,
        MIN_GRID_SPACING: 0.003,
        MAX_GRID_SPACING: 0.025,
        ATR_PERIOD: 14,
        ATR_MULTIPLIER: 1.5,
        REBALANCE_THRESHOLD: 0.08,
        DCA_PERCENTAGE: 0.015,
        MAX_POSITION_SIZE: 0.08,
        STOP_LOSS_PERCENTAGE: 0.04,
        TAKE_PROFIT_PERCENTAGE: 0.025,
        MAX_DAILY_TRADES: 4550,
        VOLATILITY_THRESHOLD: 0.02,
        BYBIT_API_KEY: "Q4M7BghXdqoJNlgeDz",
        BYBIT_API_SECRET: "4YvZ21o9aAay9rRYdCyVk10pj92VvdA0dWDU",
        BYBIT_BASE: "https://api.bybit.com",
        TELEGRAM_TOKEN: "7970734231:AAFlgJjMGNNrnZY-2rpzINBCHXka-GUHfVU",
        TELEGRAM_CHAT_ID: 6822395868,
        DEMO_MODE: false,
        BOT_RUNNING: true,
      };
} catch (e) {
  console.error("Failed to parse config.json:", e.message);
  process.exit(1);
}




// Minimum lot sizes per symbol
const MIN_LOT_SIZES = {
  'BTCUSDT': 0.001,
  'ETHUSDT': 0.01,
  'SOLUSDT': 0.1,
  'XRPUSDT': 20,
  'BNBUSDT': 0.07
};
const DEFAULT_MIN_LOT = 0.001;

// Unified state management
function getSymbols() {
  return Object.keys(config.SYMBOLS);
}

function loadSymbolState(sym) {
  const stateFile = `${DATA_DIR}/state_${sym}.json`;
  if (fs.existsSync(stateFile)) {
    try {
      return JSON.parse(fs.readFileSync(stateFile, "utf8"));
    } catch (e) {
      console.error(`Error loading state for ${sym}:`, e.message);
    }
  }
  
  // Migrate from old file structure if exists
  const oldState = {};
  if (fs.existsSync(`${DATA_DIR}/trades_${sym}.json`)) {
    oldState.trades = JSON.parse(fs.readFileSync(`${DATA_DIR}/trades_${sym}.json`, "utf8"));
  }
  if (fs.existsSync(`${DATA_DIR}/performance_${sym}.json`)) {
    oldState.performance = JSON.parse(fs.readFileSync(`${DATA_DIR}/performance_${sym}.json`, "utf8"));
  }
  if (fs.existsSync(`${DATA_DIR}/open_trade_${sym}.json`)) {
    oldState.openTrade = JSON.parse(fs.readFileSync(`${DATA_DIR}/open_trade_${sym}.json`, "utf8"));
  }
  
  return {
    trades: oldState.trades || [],
    performance: oldState.performance || {},
    openTrade: oldState.openTrade || null,
    hedgeTrade: null,
    gridAnchor: null,
    activeGrid: [],
    lastGridMovePx: null,
    ...oldState
  };
}

function saveSymbolState(sym) {
  const stateFile = `${DATA_DIR}/state_${sym}.json`;
  fs.writeFileSync(stateFile, JSON.stringify(symbolStates[sym], null, 2));
}

// Initialize all symbol states
let symbolStates = {};
for (const sym of getSymbols()) {
  symbolStates[sym] = loadSymbolState(sym);
}

// Telegram Notification System
const tg = config.TELEGRAM_TOKEN && config.TELEGRAM_CHAT_ID
  ? new TelegramBot(config.TELEGRAM_TOKEN, { polling: false })
  : null;

function sendTradeAlert(type, symbol, event, details = []) {
  const emojiMap = {
    open: "🟢", close: "✅", hedge: "🟡", stop: "🔴", 
    warn: "⚠️", error: "❌", gridmove: "⬆️", info: "ℹ️"
  };
  
  const message = [
    `${emojiMap[type] || ""} ${symbol} ${event}`,
    ...details,
    `Time: ${new Date().toISOString().replace("T", " ").slice(0, 19)}`
  ].join("\n");

  if (tg) {
    tg.sendMessage(config.TELEGRAM_CHAT_ID, message)
      .catch(err => console.error("Telegram send error:", err.message));
  }
}

// Unified public API call
async function bybitPublic(endpoint, params = {}) {
  const url = `${config.BYBIT_BASE}${endpoint}`;
  try {
    const resp = await axios.get(url, { params, timeout: 5000 });
    if (resp.data.retCode !== 0) throw new Error(resp.data.retMsg);
    return resp.data.result;
  } catch (error) {
    if (error.response) {
      throw new Error(`Bybit API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`Network error: ${error.message}`);
  }
}

// Market data fetching
async function fetchKlines(symbol, interval, limit = 100) {
  if (!config.BYBIT_API_KEY || config.DEMO_MODE) {
    // Generate realistic demo data
    const now = Date.now();
    const candles = [];
    let price = 50000;
    
    for (let i = 0; i < limit; i++) {
      const volatility = 0.005;
      price *= 1 + (Math.random() - 0.5) * volatility;
      
      const open = price;
      const high = price * (1 + Math.random() * 0.01);
      const low = price * (1 - Math.random() * 0.01);
      const close = price * (1 + (Math.random() - 0.5) * 0.008);
      
      candles.push({
        open: +open.toFixed(2),
        high: +high.toFixed(2),
        low: +low.toFixed(2),
        close: +close.toFixed(2),
        volume: +(Math.random() * 100).toFixed(2),
        timestamp: now - (limit - i - 1) * 60 * 1000
      });
      
      price = close;
    }
    return candles;
  }
  
  try {
    const data = await bybitPublic("/v5/market/kline", {
      category: "linear", symbol, interval, limit
    });
    
    return data.list.map(c => ({
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5]),
      timestamp: Number(c[0])
    })).reverse();
  } catch (error) {
    sendTradeAlert("error", symbol, "Kline Fetch Error", [error.message]);
    return [];
  }
}

// Grid calculation
function recalcGrid(anchorPx, config) {
  const gridLevels = config.GRID_STEPS || 5;
  const spacing = config.GRID_SPACING || 0.003;
  
  return Array.from({ length: gridLevels }, (_, i) => {
    const index = i - Math.floor(gridLevels / 2);
    return +(anchorPx * (1 + index * spacing)).toFixed(2);
  });
}

// Trading signal generation
function multiFactorEntry(candles) {
  const closes = candles.map(c => c.close);
  const volumes = candles.map(c => c.volume);
  
  if (closes.length < 55) return { signal: null, reason: "Insufficient data" };
  
  try {
    const emaFast = ta.EMA.calculate({ period: 20, values: closes });
    const emaSlow = ta.EMA.calculate({ period: 50, values: closes });
    const rsi = ta.RSI.calculate({ period: 14, values: closes });
    const macd = ta.MACD.calculate({ values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9 });
    const avgVol = ta.SMA.calculate({ period: 20, values: volumes }).pop() || 0;
    
    const lastIndex = closes.length - 1;
    const currVol = volumes[lastIndex];
    const lastEmaFast = emaFast[emaFast.length - 1];
    const lastEmaSlow = emaSlow[emaSlow.length - 1];
    const lastRsi = rsi[rsi.length - 1];
    const lastMacdHist = macd.length ? macd[macd.length - 1].histogram : null;
    
    if (
      lastEmaFast > lastEmaSlow &&
      lastRsi > 52 &&
      lastMacdHist > 0 &&
      currVol > avgVol * 1.2
    ) {
      return { signal: "long", reason: "Bullish trend: EMA crossover, RSI >52, MACD positive, volume spike" };
    }
    
    if (
      lastEmaFast < lastEmaSlow &&
      lastRsi < 48 &&
      lastMacdHist < 0 &&
      currVol > avgVol * 1.2
    ) {
      return { signal: "short", reason: "Bearish trend: EMA crossover, RSI <48, MACD negative, volume spike" };
    }
  } catch (e) {
    console.error("Indicator calculation error:", e.message);
  }
  
  return { signal: null, reason: "No clear signal" };
}

// Trade closure handler
async function closeTrade(sym, closeReason, exitPrice, tradeType = 'main') {
  const state = symbolStates[sym];
  let trade;
  
  if (tradeType === 'main') {
    trade = state.openTrade;
    if (!trade) return false;
  } else if (tradeType === 'hedge') {
    trade = state.hedgeTrade;
    if (!trade) return false;
  } else {
    return false;
  }

  const isRealTrade = !config.DEMO_MODE && config.BYBIT_API_KEY && config.BYBIT_API_SECRET;
  const profitPct = trade.side === 'long' 
    ? ((exitPrice - trade.entryPx) / trade.entryPx) * 100
    : ((trade.entryPx - exitPrice) / trade.entryPx) * 100;

  try {
    if (isRealTrade) {
      await closeOrder({
        symbol: sym,
        openSide: trade.side === 'long' ? 'BUY' : 'SELL',
        qty: trade.size,
        apiKey: config.BYBIT_API_KEY,
        apiSecret: config.BYBIT_API_SECRET,
        baseUrl: config.BYBIT_BASE
      });
    }

    // Record trade history
    state.trades.push({
      ...trade,
      tradeType,
      closeReason,
      exitPrice,
      closeTime: Date.now(),
      profitPct
    });

    // Clear trade position
    if (tradeType === 'main') {
      state.openTrade = null;
      // Also close hedge if main is closing
      if (state.hedgeTrade) {
        await closeTrade(sym, 'MAIN_CLOSED', exitPrice, 'hedge');
      }
    } else {
      state.hedgeTrade = null;
    }

    saveSymbolState(sym);
    
    sendTradeAlert('close', sym, `${tradeType.toUpperCase()} Position Closed`, [
      `Side: ${trade.side.toUpperCase()}`,
      `Size: ${trade.size.toFixed(6)}`,
      `Entry: ${trade.entryPx.toFixed(2)}`,
      `Exit: ${exitPrice.toFixed(2)}`,
      `Profit: ${profitPct.toFixed(2)}%`,
      `Reason: ${closeReason}`
    ]);
    
    return true;
  } catch (error) {
    sendTradeAlert('error', sym, `Close ${tradeType} Failed`, [error.message]);
    return false;
  }
}

// ---- MAIN LOOP WITH HEDGING AND ADVANCED TP/SL ----
async function mainLoop() {
  if (!config.BOT_RUNNING) return;
  
  for (const sym of getSymbols()) {
    try {
      const symbolConfig = config.SYMBOLS[sym];
      const state = symbolStates[sym];
      
      // Fetch market data
      const candles = await fetchKlines(sym, symbolConfig.TIMEFRAME, 100);
      if (candles.length === 0) continue;
      
      const lastCandle = candles[candles.length - 1];
      const lastPx = lastCandle.close;
      
      // --- Grid Management ---
      if (!state.gridAnchor || 
          Math.abs(lastPx / state.gridAnchor - 1) > (symbolConfig.GRID_TRAIL_THRESHOLD || 0.01)) {
        
        state.gridAnchor = lastPx;
        state.activeGrid = recalcGrid(lastPx, symbolConfig);
        state.lastGridMovePx = lastPx;
        
        sendTradeAlert("gridmove", sym, "Grid Updated", [
          `Anchor: ${lastPx.toFixed(2)}`,
          `Levels: ${state.activeGrid.map(p => p.toFixed(2)).join(', ')}`
        ]);
        
        saveSymbolState(sym);
      }
      
      // --- Trade Entry Logic ---
      if (!state.openTrade) {
        const { signal, reason } = multiFactorEntry(candles);
        
        if (signal) {
          const capital = symbolConfig.CAPITAL || 1000;
          const riskPercent = symbolConfig.RISK_PERCENT || 1;
          const leverage = symbolConfig.LEVERAGE || 1;
          
          let sizeTotal = (capital * riskPercent / 100) * leverage / lastPx;
          
          // Apply symbol-specific minimum order size
  

const minLot = MIN_LOT_SIZES[sym] || DEFAULT_MIN_LOT;

if (sizeTotal < minLot) {
  sendTradeAlert("warn", sym, "Lot size below minimum", [
    `Calculated size: ${sizeTotal.toFixed(6)}`,
    `Using min lot size instead: ${minLot}`
  ]);
  sizeTotal = minLot;
}
          
          const isRealTrade = !config.DEMO_MODE && config.BYBIT_API_KEY && config.BYBIT_API_SECRET;
          let orderResult = null;
          
          try {
            if (isRealTrade) {
              orderResult = await placeOrder({
                symbol: sym,
                side: signal === "long" ? "BUY" : "SELL",
                qty: sizeTotal,
                apiKey: config.BYBIT_API_KEY,
                apiSecret: config.BYBIT_API_SECRET,
                baseUrl: config.BYBIT_BASE
              });
            }
            
            state.openTrade = {
              side: signal,
              entryPx: lastPx,
              size: sizeTotal,
              openTime: Date.now(),
              orderId: orderResult ? orderResult.orderId : `DEMO-${Date.now()}`
            };
            
            saveSymbolState(sym);
            
            sendTradeAlert("open", sym, `Position Opened (${isRealTrade ? "REAL" : "DEMO"})`, [
              `Side: ${signal.toUpperCase()}`,
              `Size: ${sizeTotal.toFixed(6)}`,
              `Entry: ${lastPx.toFixed(2)}`,
              `Reason: ${reason}`
            ]);
          } catch (error) {
            sendTradeAlert("error", sym, "Entry Failed", [error.message]);
          }
        }
      } 
      // --- Trade Management Logic ---
      else {
        const trade = state.openTrade;
        
        // Initialize price tracking
        if (!trade.maxPrice) trade.maxPrice = trade.entryPx;
        if (!trade.minPrice) trade.minPrice = trade.entryPx;
        
        // Update price extremes
        if (trade.side === 'long' && lastPx > trade.maxPrice) {
          trade.maxPrice = lastPx;
        } else if (trade.side === 'short' && lastPx < trade.minPrice) {
          trade.minPrice = lastPx;
        }
        
        // Calculate main trade profit
        const mainProfitPct = trade.side === 'long'
          ? ((lastPx - trade.entryPx) / trade.entryPx) * 100
          : ((trade.entryPx - lastPx) / trade.entryPx) * 100;
        
        // --- Hedging Logic ---
        if (!state.hedgeTrade && mainProfitPct <= -symbolConfig.HEDGE_LOSS_PERCENT) {
          // Open hedge position (opposite direction)
          const hedgeSize = trade.size;
          const isRealTrade = !config.DEMO_MODE && config.BYBIT_API_KEY && config.BYBIT_API_SECRET;
          const hedgeSide = trade.side === 'long' ? 'SELL' : 'BUY';
          
          try {
            if (isRealTrade) {
              await placeOrder({
                symbol: sym,
                side: hedgeSide,
                qty: hedgeSize,
                apiKey: config.BYBIT_API_KEY,
                apiSecret: config.BYBIT_API_SECRET,
                baseUrl: config.BYBIT_BASE
              });
            }
            
            state.hedgeTrade = {
              side: hedgeSide.toLowerCase(),
              entryPx: lastPx,
              size: hedgeSize,
              openTime: Date.now(),
              isHedge: true,
              stopLossPrice: null  // Will be set later
            };
            
            saveSymbolState(sym);
            
            sendTradeAlert('hedge', sym, 'Hedge Position Opened', [
              `Main PnL: ${mainProfitPct.toFixed(2)}%`,
              `Side: ${hedgeSide}`,
              `Size: ${hedgeSize.toFixed(6)}`,
              `Entry: ${lastPx.toFixed(2)}`
            ]);
          } catch (error) {
            sendTradeAlert('error', sym, 'Hedge Open Failed', [error.message]);
          }
        }
        
        // --- Hedge Position Management ---
        if (state.hedgeTrade) {
          const hedge = state.hedgeTrade;
          
          // Calculate hedge profit
          const hedgeProfitPct = hedge.side === 'long'
            ? ((lastPx - hedge.entryPx) / hedge.entryPx) * 100
            : ((hedge.entryPx - lastPx) / hedge.entryPx) * 100;
          
          // Activate hedge SL at 8% profit
          if (hedgeProfitPct >= symbolConfig.HEDGE_TP_PERCENT && !hedge.stopLossPrice) {
            if (hedge.side === 'long') {
              hedge.stopLossPrice = hedge.entryPx * (1 + (hedgeProfitPct - symbolConfig.HEDGE_SL_PERCENT) / 100);
            } else {
              hedge.stopLossPrice = hedge.entryPx * (1 - (hedgeProfitPct - symbolConfig.HEDGE_SL_PERCENT) / 100);
            }
            
            saveSymbolState(sym);
            sendTradeAlert('info', sym, 'Hedge Stop Loss Activated', [
              `Profit: ${hedgeProfitPct.toFixed(2)}%`,
              `SL Price: ${hedge.stopLossPrice.toFixed(2)}`
            ]);
          }
          
          // Check hedge stop loss
          if (hedge.stopLossPrice) {
            if ((hedge.side === 'long' && lastPx <= hedge.stopLossPrice) ||
                (hedge.side === 'short' && lastPx >= hedge.stopLossPrice)) {
              await closeTrade(sym, 'HEDGE_SL_HIT', lastPx, 'hedge');
            }
          }
        }
        
        // --- Main Position Take Profit & Stop Loss ---
        // Set SL at 10% when profit > 20%
        if (mainProfitPct > symbolConfig.MAIN_PROTECTION_START && !trade.stopLossPrice) {
          if (trade.side === 'long') {
            trade.stopLossPrice = trade.entryPx * (1 + symbolConfig.MAIN_PROTECTION_PERCENT / 100);
          } else {
            trade.stopLossPrice = trade.entryPx * (1 - symbolConfig.MAIN_PROTECTION_PERCENT / 100);
          }
          
          saveSymbolState(sym);
          sendTradeAlert('info', sym, 'Main Stop Loss Updated', [
            `Profit: ${mainProfitPct.toFixed(2)}%`,
            `SL Price: ${trade.stopLossPrice.toFixed(2)}`
          ]);
        }
        
        // Take profit at 50%
        if (mainProfitPct >= symbolConfig.MAIN_TP_PERCENT) {
          await closeTrade(sym, 'MAIN_TP_50%', lastPx, 'main');
          continue;  // Skip further processing for this symbol
        }
        
        // Check main stop loss
        if (trade.stopLossPrice) {
          if ((trade.side === 'long' && lastPx <= trade.stopLossPrice) ||
              (trade.side === 'short' && lastPx >= trade.stopLossPrice)) {
            await closeTrade(sym, 'MAIN_SL_HIT', lastPx, 'main');
            continue;  // Skip further processing
          }
        }
      }
    } catch (error) {
      sendTradeAlert('error', sym, 'Main Loop Error', [error.message]);
    }
  }
}

// Start main loop
setInterval(mainLoop, 20000);

// Periodic state saving
setInterval(() => {
  for (const sym of getSymbols()) {
    try {
      saveSymbolState(sym);
    } catch (e) {
      console.error(`Periodic save failed for ${sym}:`, e.message);
    }
  }
}, 300000); // 5 minutes

// ----------- REST API ENDPOINTS -----------

 // app.use(cors())
 // In your bot server code (index.js)
//import cors from 'cors';

// Add after creating express app
app.use(cors({
  origin: [
    'http://localhost:3000', 
    'http://your-production-domain.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  credentials: true
}));
  app.use(express.json())
app.use(express.static('public'));
// Add to your bot server routes
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

app.get("/api/status", async (req, res) => {
  try {
    const result = {};
    for (const sym of getSymbols()) {
      const symbolConfig = config.SYMBOLS[sym];
      const state = symbolStates[sym];
      
      const candles = await fetchKlines(sym, symbolConfig.TIMEFRAME, 100);
      const lastPx = candles.length > 0 ? candles[candles.length - 1].close : 0;
      
      result[sym] = {
        status: {
          isRunning: config.BOT_RUNNING,
          currentPrice: lastPx,
          uptime: process.uptime() * 1000,
          demoMode: !!config.DEMO_MODE,
          openTrade: state.openTrade,
          hedgeTrade: state.hedgeTrade,
          gridAnchor: state.gridAnchor,
          gridLevels: state.activeGrid
        },
        trades: state.trades.slice(-50), // Last 50 trades
        performance: state.performance,
        priceHistory: candles.map(c => c.close).slice(-100), // Last 100 prices
        config: symbolConfig,
      };
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


//const axios = require("axios");
//const crypto = require("crypto");
//const express = require("express");
//const app = express();



//const axios = require("axios");
//const crypto = require("crypto");

app.get("/api/balance", async (req, res) => {
  try {
    const apiKey = config.BYBIT_API_KEY;
    const apiSecret = config.BYBIT_API_SECRET;

    const timestamp = Date.now().toString();
    const recvWindow = "60000";
    const queryString = "accountType=UNIFIED";

    // ✅ Origin string for V5 signature
    const originString = timestamp + apiKey + recvWindow + queryString;

    // ✅ HMAC SHA256
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(originString)
      .digest("hex");

    const headers = {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
    };

    const url = `${config.BYBIT_BASE}/v5/account/wallet-balance?${queryString}`;

    const response = await axios.get(url, {
      headers,
      timeout: 5000,
    });

    if (response.data.retCode !== 0) {
      throw new Error(response.data.retMsg || "Bybit API error");
    }

    const coins = response.data.result.list[0].coin.map((c) => ({
      coin: c.coin,
      availableBalance: Number(c.availableToWithdraw),
      free: Number(c.availableToWithdraw),
      total: Number(c.walletBalance),
    }));

    res.json({ balances: coins });
  } catch (e) {
    console.error("Balance API error:", e.message);
    res.status(500).json({ error: e.message, balances: [] });
  }
});

app.get("/api/grid", async (req, res) => {
  try {
    const symbol = req.query.symbol || getSymbols()[0];
    if (!symbol || !config.SYMBOLS[symbol]) {
      return res.status(400).json({ error: "Invalid symbol" });
    }
    
    const symbolConfig = config.SYMBOLS[symbol];
    const state = symbolStates[symbol];
    
    res.json({
      grid: state.activeGrid.map((price, i) => ({
        level: i + 1,
        price,
        distance: +((price / state.gridAnchor - 1) * 100).toFixed(2) + "%"
      })),
      anchor: state.gridAnchor,
      lastPrice: state.lastGridMovePx
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/trades", (req, res) => {
  const trades = {};
  for (const sym of getSymbols()) {
    trades[sym] = symbolStates[sym].trades.slice(-100); // Last 100 trades
  }
  res.json(trades);
});

app.get("/api/performance", (req, res) => {
  const performance = {};
  for (const sym of getSymbols()) {
       const trades = symbolStates[sym].trades.filter(t => t.profitPct !== undefined);
    const wins = trades.filter(t => t.profitPct > 0).length;
    
    performance[sym] = {
      totalTrades: trades.length,
      winRate: trades.length ? `${(wins / trades.length * 100).toFixed(1)}%` : "0%",
      avgProfit: trades.length ? 
        (trades.reduce((sum, t) => sum + (t.profitPct || 0), 0) / trades.length).toFixed(2) + "%" : "0%",
      lastUpdated: new Date().toISOString()
    };
  }
  res.json(performance);
});

app.get("/api/config", (req, res) => res.json(config));

app.patch("/api/config/symbol/:symbol", (req, res) => {
  const { symbol } = req.params;
  if (!config.SYMBOLS[symbol]) {
    return res.status(400).json({ error: "Invalid symbol" });
  }
  
  config.SYMBOLS[symbol] = { ...config.SYMBOLS[symbol], ...req.body };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // Reinitialize state for symbol
  symbolStates[symbol] = loadSymbolState(symbol);
  
  res.json({ success: true, config: config.SYMBOLS[symbol] });
});

app.post("/api/config/symbol", (req, res) => {
  const { symbol, config: symConfig } = req.body;
  if (!symbol || !symConfig) {
    return res.status(400).json({ error: "Symbol and config required" });
  }
  
  config.SYMBOLS[symbol] = symConfig;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // Initialize new symbol state
  symbolStates[symbol] = loadSymbolState(symbol);
  
  res.json({ success: true, config: symConfig });
});

app.delete("/api/config/symbol/:symbol", (req, res) => {
  const { symbol } = req.params;
  if (!config.SYMBOLS[symbol]) {
    return res.status(400).json({ error: "Invalid symbol" });
  }
  
  delete config.SYMBOLS[symbol];
  delete symbolStates[symbol];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // Remove state file
  const stateFile = `${DATA_DIR}/state_${symbol}.json`;
  if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
  
  res.json({ success: true });
});

app.put("/api/config", (req, res) => {
  config = { ...config, ...req.body };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  
  // Sync symbol states with config
  for (const sym of getSymbols()) {
    if (!symbolStates[sym]) symbolStates[sym] = loadSymbolState(sym);
  }
  
  // Remove states for deleted symbols
  for (const sym in symbolStates) {
    if (!config.SYMBOLS[sym]) {
      delete symbolStates[sym];
    }
  }
  
  res.json({ success: true, config });
});

app.post("/api/control", (req, res) => {
  const { action } = req.body;
  if (!action) return res.status(400).json({ success: false, message: "Action required" });
  
  switch (action.toLowerCase()) {
    case "start":
      config.BOT_RUNNING = true;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return res.json({ success: true, message: "Trading enabled" });
      
    case "stop":
      config.BOT_RUNNING = false;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
      return res.json({ success: true, message: "Trading suspended" });
      
    case "flush":
      // Save all states immediately
      for (const sym of getSymbols()) saveSymbolState(sym);
      return res.json({ success: true, message: "All states saved" });
      
    default:
      return res.status(400).json({ success: false, message: "Invalid action" });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Trading Bot API running on port ${PORT}`);
  console.log(`📊 Monitoring ${getSymbols().length} symbols`);
  console.log(`💾 Data directory: ${DATA_DIR}`);
  console.log("⚙️  Minimum order sizes:");
  for (const [sym, size] of Object.entries(MIN_LOT_SIZES)) {
    console.log(`    ${sym}: ${size}`);
  }
});
