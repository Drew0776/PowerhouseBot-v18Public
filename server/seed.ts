import type { StockData, DailyCandle, AnalystAction, CatalystEvent, StockCategory, MarketStatus, OptionsFlowRow } from "@shared/schema";

// Deterministic seeded random
function seededRandom(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface StockInfo {
  name: string;
  price: number;
  volatility: number;
  bias: number;
  category: StockCategory;
  sector: string;
  marketCapBillions: number;
  floatMillions: number;
  shortInterestBase: number;
  institutionalOwnership: number;
  beta: number;
  // Multi-market
  marketType?: "stock" | "crypto" | "forex" | "commodity" | "index";
  exchange?: string;
  tradingHours?: "24/7" | "24/5" | "market_hours";
  pipSize?: number;
}

const STOCK_INFO: Record<string, StockInfo> = {
  // AI & Tech (existing 15)
  NVDA: { name: "NVIDIA Corp", price: 177, volatility: 0.028, bias: 0.003, category: "ai-tech", sector: "Semiconductors", marketCapBillions: 4350, floatMillions: 24400, shortInterestBase: 1.2, institutionalOwnership: 65, beta: 1.7 },
  MSFT: { name: "Microsoft Corp", price: 373, volatility: 0.015, bias: 0.001, category: "ai-tech", sector: "Software", marketCapBillions: 2780, floatMillions: 7430, shortInterestBase: 0.8, institutionalOwnership: 72, beta: 0.9 },
  GOOGL: { name: "Alphabet Inc", price: 296, volatility: 0.018, bias: 0.001, category: "ai-tech", sector: "Internet Services", marketCapBillions: 1850, floatMillions: 5790, shortInterestBase: 1.0, institutionalOwnership: 68, beta: 1.1 },
  AMZN: { name: "Amazon.com Inc", price: 210, volatility: 0.02, bias: 0.002, category: "ai-tech", sector: "E-Commerce", marketCapBillions: 2150, floatMillions: 10200, shortInterestBase: 0.9, institutionalOwnership: 60, beta: 1.2 },
  META: { name: "Meta Platforms", price: 574, volatility: 0.022, bias: 0.002, category: "ai-tech", sector: "Social Media", marketCapBillions: 1470, floatMillions: 2280, shortInterestBase: 1.1, institutionalOwnership: 78, beta: 1.3 },
  AAPL: { name: "Apple Inc", price: 256, volatility: 0.014, bias: 0.0005, category: "ai-tech", sector: "Consumer Electronics", marketCapBillions: 3920, floatMillions: 15300, shortInterestBase: 0.6, institutionalOwnership: 60, beta: 1.2 },
  AVGO: { name: "Broadcom Inc", price: 315, volatility: 0.025, bias: 0.002, category: "ai-tech", sector: "Semiconductors", marketCapBillions: 735, floatMillions: 4150, shortInterestBase: 1.4, institutionalOwnership: 82, beta: 1.2 },
  AMD: { name: "AMD Inc", price: 218, volatility: 0.032, bias: 0.005, category: "ai-tech", sector: "Semiconductors", marketCapBillions: 352, floatMillions: 1610, shortInterestBase: 3.5, institutionalOwnership: 75, beta: 1.8 },
  PLTR: { name: "Palantir Technologies", price: 148, volatility: 0.035, bias: 0.004, category: "ai-tech", sector: "Enterprise Software", marketCapBillions: 340, floatMillions: 1830, shortInterestBase: 4.2, institutionalOwnership: 45, beta: 2.1 },
  CRWD: { name: "CrowdStrike Holdings", price: 399, volatility: 0.03, bias: 0.006, category: "ai-tech", sector: "Cybersecurity", marketCapBillions: 95, floatMillions: 225, shortInterestBase: 3.0, institutionalOwnership: 70, beta: 1.4 },
  SNOW: { name: "Snowflake Inc", price: 152, volatility: 0.028, bias: -0.001, category: "ai-tech", sector: "Cloud Computing", marketCapBillions: 51, floatMillions: 310, shortInterestBase: 5.5, institutionalOwnership: 62, beta: 1.6 },
  TSM: { name: "Taiwan Semiconductor", price: 339, volatility: 0.02, bias: 0.002, category: "ai-tech", sector: "Semiconductors", marketCapBillions: 880, floatMillions: 5170, shortInterestBase: 0.4, institutionalOwnership: 19, beta: 1.2 },
  TSLA: { name: "Tesla Inc", price: 361, volatility: 0.04, bias: -0.004, category: "ai-tech", sector: "Electric Vehicles", marketCapBillions: 1140, floatMillions: 2550, shortInterestBase: 3.8, institutionalOwnership: 44, beta: 2.0 },
  NOW: { name: "ServiceNow Inc", price: 102, volatility: 0.02, bias: 0.001, category: "ai-tech", sector: "Enterprise Software", marketCapBillions: 210, floatMillions: 205, shortInterestBase: 1.8, institutionalOwnership: 85, beta: 1.1 },
  ARM: { name: "Arm Holdings", price: 149, volatility: 0.033, bias: 0.003, category: "ai-tech", sector: "Semiconductors", marketCapBillions: 153, floatMillions: 102, shortInterestBase: 8.5, institutionalOwnership: 35, beta: 1.9 },
  // Penny Stocks / Micro-caps (15 new)
  SOUN: { name: "SoundHound AI", price: 3.20, volatility: 0.06, bias: 0.005, category: "penny", sector: "AI Software", marketCapBillions: 1.2, floatMillions: 220, shortInterestBase: 18.5, institutionalOwnership: 28, beta: 3.2 },
  BBAI: { name: "BigBear.ai", price: 2.80, volatility: 0.055, bias: 0.003, category: "penny", sector: "AI Analytics", marketCapBillions: 0.65, floatMillions: 145, shortInterestBase: 22.3, institutionalOwnership: 22, beta: 2.8 },
  GFAI: { name: "Guardforce AI", price: 1.45, volatility: 0.08, bias: -0.002, category: "penny", sector: "AI Robotics", marketCapBillions: 0.08, floatMillions: 15, shortInterestBase: 12.1, institutionalOwnership: 8, beta: 3.5 },
  DNA: { name: "Ginkgo Bioworks", price: 0.85, volatility: 0.07, bias: -0.005, category: "penny", sector: "Synthetic Biology", marketCapBillions: 1.5, floatMillions: 1200, shortInterestBase: 14.8, institutionalOwnership: 35, beta: 2.6 },
  NKLA: { name: "Nikola Corp", price: 0.42, volatility: 0.09, bias: -0.008, category: "penny", sector: "Electric Vehicles", marketCapBillions: 0.35, floatMillions: 520, shortInterestBase: 28.5, institutionalOwnership: 15, beta: 3.8 },
  MARA: { name: "Marathon Digital", price: 12.50, volatility: 0.065, bias: 0.004, category: "penny", sector: "Crypto Mining", marketCapBillions: 3.8, floatMillions: 198, shortInterestBase: 19.2, institutionalOwnership: 42, beta: 3.4 },
  RIOT: { name: "Riot Platforms", price: 8.20, volatility: 0.06, bias: 0.003, category: "penny", sector: "Crypto Mining", marketCapBillions: 2.7, floatMillions: 245, shortInterestBase: 16.8, institutionalOwnership: 48, beta: 3.2 },
  WULF: { name: "TeraWulf Inc", price: 2.10, volatility: 0.07, bias: 0.002, category: "penny", sector: "Crypto Mining", marketCapBillions: 0.72, floatMillions: 240, shortInterestBase: 21.5, institutionalOwnership: 30, beta: 3.0 },
  IREN: { name: "Iris Energy", price: 6.80, volatility: 0.055, bias: 0.004, category: "penny", sector: "Crypto Mining", marketCapBillions: 1.3, floatMillions: 125, shortInterestBase: 13.5, institutionalOwnership: 38, beta: 2.9 },
  BTBT: { name: "Bit Digital", price: 1.90, volatility: 0.065, bias: 0.001, category: "penny", sector: "Crypto Mining", marketCapBillions: 0.22, floatMillions: 85, shortInterestBase: 9.8, institutionalOwnership: 18, beta: 3.1 },
  KULR: { name: "KULR Technology", price: 1.55, volatility: 0.075, bias: 0.002, category: "penny", sector: "Battery Tech", marketCapBillions: 0.25, floatMillions: 105, shortInterestBase: 15.2, institutionalOwnership: 12, beta: 2.7 },
  SNDL: { name: "SNDL Inc", price: 1.80, volatility: 0.05, bias: -0.001, category: "penny", sector: "Cannabis", marketCapBillions: 0.48, floatMillions: 210, shortInterestBase: 8.5, institutionalOwnership: 14, beta: 2.3 },
  APRE: { name: "Aprea Therapeutics", price: 0.65, volatility: 0.085, bias: 0.006, category: "penny", sector: "Biotech", marketCapBillions: 0.04, floatMillions: 8, shortInterestBase: 6.2, institutionalOwnership: 20, beta: 2.5 },
  RAIL: { name: "FreightCar America", price: 1.25, volatility: 0.06, bias: 0.001, category: "penny", sector: "Industrials", marketCapBillions: 0.02, floatMillions: 12, shortInterestBase: 4.5, institutionalOwnership: 25, beta: 1.8 },
  CLOV: { name: "Clover Health", price: 2.30, volatility: 0.055, bias: -0.002, category: "penny", sector: "Healthcare Tech", marketCapBillions: 1.1, floatMillions: 340, shortInterestBase: 11.2, institutionalOwnership: 32, beta: 2.4 },
  // Momentum / Short Squeeze candidates (15 new)
  SMCI: { name: "Super Micro Computer", price: 38, volatility: 0.05, bias: 0.003, category: "momentum", sector: "Computer Hardware", marketCapBillions: 22, floatMillions: 480, shortInterestBase: 24.5, institutionalOwnership: 55, beta: 2.5 },
  IWM: { name: "Russell 2000 ETF", price: 195, volatility: 0.018, bias: 0.001, category: "momentum", sector: "ETF", marketCapBillions: 68, floatMillions: 340000, shortInterestBase: 0.2, institutionalOwnership: 45, beta: 1.0 },
  RIVN: { name: "Rivian Automotive", price: 14.50, volatility: 0.045, bias: -0.002, category: "momentum", sector: "Electric Vehicles", marketCapBillions: 14.5, floatMillions: 780, shortInterestBase: 16.2, institutionalOwnership: 55, beta: 2.2 },
  LCID: { name: "Lucid Group", price: 2.80, volatility: 0.05, bias: -0.003, category: "momentum", sector: "Electric Vehicles", marketCapBillions: 6.4, floatMillions: 1850, shortInterestBase: 19.8, institutionalOwnership: 42, beta: 2.6 },
  SOFI: { name: "SoFi Technologies", price: 12.40, volatility: 0.04, bias: 0.003, category: "momentum", sector: "Fintech", marketCapBillions: 13.2, floatMillions: 880, shortInterestBase: 10.5, institutionalOwnership: 50, beta: 1.8 },
  RKLB: { name: "Rocket Lab USA", price: 22, volatility: 0.045, bias: 0.005, category: "momentum", sector: "Aerospace", marketCapBillions: 10.5, floatMillions: 385, shortInterestBase: 8.2, institutionalOwnership: 42, beta: 2.3 },
  IONQ: { name: "IonQ Inc", price: 28, volatility: 0.055, bias: 0.004, category: "momentum", sector: "Quantum Computing", marketCapBillions: 6.2, floatMillions: 165, shortInterestBase: 15.5, institutionalOwnership: 38, beta: 2.8 },
  RGTI: { name: "Rigetti Computing", price: 8.50, volatility: 0.065, bias: 0.003, category: "momentum", sector: "Quantum Computing", marketCapBillions: 1.8, floatMillions: 145, shortInterestBase: 22.8, institutionalOwnership: 28, beta: 3.1 },
  QUBT: { name: "Quantum Computing Inc", price: 5.20, volatility: 0.07, bias: 0.002, category: "momentum", sector: "Quantum Computing", marketCapBillions: 0.85, floatMillions: 95, shortInterestBase: 18.5, institutionalOwnership: 15, beta: 3.4 },
  AFRM: { name: "Affirm Holdings", price: 55, volatility: 0.04, bias: 0.003, category: "momentum", sector: "Fintech", marketCapBillions: 17.2, floatMillions: 270, shortInterestBase: 9.8, institutionalOwnership: 65, beta: 2.0 },
  UPST: { name: "Upstart Holdings", price: 48, volatility: 0.05, bias: 0.004, category: "momentum", sector: "Fintech", marketCapBillions: 4.2, floatMillions: 78, shortInterestBase: 25.2, institutionalOwnership: 52, beta: 2.5 },
  JOBY: { name: "Joby Aviation", price: 6.20, volatility: 0.05, bias: 0.002, category: "momentum", sector: "Air Mobility", marketCapBillions: 4.5, floatMillions: 485, shortInterestBase: 12.5, institutionalOwnership: 40, beta: 2.4 },
  LUNR: { name: "Intuitive Machines", price: 11.50, volatility: 0.055, bias: 0.005, category: "momentum", sector: "Space", marketCapBillions: 2.8, floatMillions: 120, shortInterestBase: 20.5, institutionalOwnership: 32, beta: 3.0 },
  ACHR: { name: "Archer Aviation", price: 7.80, volatility: 0.05, bias: 0.003, category: "momentum", sector: "Air Mobility", marketCapBillions: 3.2, floatMillions: 320, shortInterestBase: 14.2, institutionalOwnership: 35, beta: 2.6 },
  DJT: { name: "Trump Media", price: 18, volatility: 0.08, bias: -0.005, category: "momentum", sector: "Social Media", marketCapBillions: 3.5, floatMillions: 35, shortInterestBase: 35.5, institutionalOwnership: 5, beta: 4.2 },

  // ── HOMERUN ZONE: 30 new ultra-high volatility tickers ──────────────────────
  // V17 NEW: VRT, NBIS, CLS, OKLO added per audit recommendation
  VRT:   { name: "Vertiv Holdings",        price: 92,   volatility: 0.045, bias: 0.005, category: "momentum", sector: "AI Infrastructure", marketCapBillions: 35,  floatMillions: 360,  shortInterestBase: 6.5,  institutionalOwnership: 75,  beta: 2.0 },
  NBIS:  { name: "Nebius Group",           price: 28,   volatility: 0.070, bias: 0.008, category: "momentum", sector: "AI Cloud",          marketCapBillions: 4.8, floatMillions: 95,   shortInterestBase: 18.0, institutionalOwnership: 30,  beta: 3.5 },
  CLS:   { name: "Celestica Inc",          price: 58,   volatility: 0.050, bias: 0.006, category: "momentum", sector: "AI Hardware",       marketCapBillions: 7.2, floatMillions: 140,  shortInterestBase: 8.0,  institutionalOwnership: 68,  beta: 2.2 },
  OKLO:  { name: "Oklo Inc",               price: 22,   volatility: 0.085, bias: 0.007, category: "momentum", sector: "Nuclear Energy",    marketCapBillions: 3.1, floatMillions: 45,   shortInterestBase: 28.0, institutionalOwnership: 25,  beta: 4.2 },
  SERV:  { name: "Serve Robotics",         price: 6.80, volatility: 0.095, bias: 0.006, category: "penny",    sector: "AI Robotics",      marketCapBillions: 0.65, floatMillions: 35,  shortInterestBase: 22.0, institutionalOwnership: 18,  beta: 4.8 },
  MTSI:  { name: "MACOM Technology",       price: 118,  volatility: 0.040, bias: 0.004, category: "momentum", sector: "Semiconductors",   marketCapBillions: 8.9, floatMillions: 70,   shortInterestBase: 7.0,  institutionalOwnership: 82,  beta: 1.9 },

  // Meme stocks & short squeeze bombs
  GME:  { name: "GameStop Corp",         price: 27,   volatility: 0.09, bias: 0.001, category: "penny",    sector: "Retail",             marketCapBillions: 11.5, floatMillions: 38,   shortInterestBase: 24.0, institutionalOwnership: 30,  beta: 4.5 },
  AMC:  { name: "AMC Entertainment",     price: 3.80, volatility: 0.10, bias: -0.006, category: "penny",   sector: "Entertainment",      marketCapBillions: 1.8,  floatMillions: 232,  shortInterestBase: 22.5, institutionalOwnership: 18,  beta: 4.8 },
  KOSS: { name: "Koss Corporation",       price: 4.20, volatility: 0.12, bias: 0.002, category: "penny",   sector: "Consumer Electronics", marketCapBillions: 0.05, floatMillions: 5,    shortInterestBase: 38.0, institutionalOwnership: 12,  beta: 5.5 },
  PLUG: { name: "Plug Power Inc",         price: 1.95, volatility: 0.09, bias: -0.004, category: "penny",  sector: "Clean Energy",       marketCapBillions: 1.3,  floatMillions: 520,  shortInterestBase: 26.5, institutionalOwnership: 35,  beta: 4.2 },
  SPCE: { name: "Virgin Galactic",        price: 2.10, volatility: 0.11, bias: -0.005, category: "penny",  sector: "Space",              marketCapBillions: 0.45, floatMillions: 180,  shortInterestBase: 31.0, institutionalOwnership: 22,  beta: 5.0 },

  // Quantum computing — ultra low float, massive squeeze potential
  QBTS: { name: "D-Wave Quantum",         price: 4.80, volatility: 0.085, bias: 0.004, category: "momentum", sector: "Quantum Computing", marketCapBillions: 1.4,  floatMillions: 82,   shortInterestBase: 28.0, institutionalOwnership: 20,  beta: 4.1 },
  ARQQ: { name: "Arqit Quantum",          price: 3.60, volatility: 0.09, bias: 0.003, category: "momentum",  sector: "Quantum Computing", marketCapBillions: 0.38, floatMillions: 28,   shortInterestBase: 32.5, institutionalOwnership: 15,  beta: 4.8 },

  // Crypto / blockchain — BTC-correlated explosive movers
  BITF: { name: "Bitfarms Ltd",           price: 2.15, volatility: 0.08, bias: 0.004, category: "penny",    sector: "Crypto Mining",     marketCapBillions: 0.65, floatMillions: 290,  shortInterestBase: 21.0, institutionalOwnership: 28,  beta: 4.0 },
  HUT:  { name: "Hut 8 Corp",             price: 8.40, volatility: 0.075, bias: 0.004, category: "penny",   sector: "Crypto Mining",     marketCapBillions: 1.4,  floatMillions: 152,  shortInterestBase: 18.5, institutionalOwnership: 35,  beta: 3.8 },
  MSTR: { name: "MicroStrategy",          price: 295,  volatility: 0.065, bias: 0.005, category: "momentum", sector: "Bitcoin Treasury",  marketCapBillions: 42,   floatMillions: 118,  shortInterestBase: 14.0, institutionalOwnership: 55,  beta: 3.5 },
  COIN: { name: "Coinbase Global",         price: 185,  volatility: 0.055, bias: 0.003, category: "momentum", sector: "Crypto Exchange",  marketCapBillions: 45,   floatMillions: 220,  shortInterestBase: 12.0, institutionalOwnership: 60,  beta: 3.2 },

  // AI micro-caps — tiny floats, huge momentum
  ASTS: { name: "AST SpaceMobile",        price: 19,   volatility: 0.075, bias: 0.006, category: "momentum", sector: "Satellite Comms",  marketCapBillions: 6.8,  floatMillions: 155,  shortInterestBase: 20.5, institutionalOwnership: 38,  beta: 3.8 },
  MSAI: { name: "MultiSensor AI",         price: 1.10, volatility: 0.11, bias: 0.003, category: "penny",    sector: "AI Sensors",        marketCapBillions: 0.08, floatMillions: 12,   shortInterestBase: 35.0, institutionalOwnership: 8,   beta: 5.2 },
  AIXI: { name: "Xiao-I Corporation",     price: 0.75, volatility: 0.13, bias: -0.002, category: "penny",   sector: "AI Software",      marketCapBillions: 0.03, floatMillions: 8,    shortInterestBase: 18.0, institutionalOwnership: 5,   beta: 5.8 },

  // Biotech FDA rockets — binary event machines
  SAVA: { name: "Cassava Sciences",       price: 5.80, volatility: 0.12, bias: -0.003, category: "penny",   sector: "Biotech",           marketCapBillions: 0.22, floatMillions: 25,   shortInterestBase: 42.0, institutionalOwnership: 28,  beta: 5.5 },
  NKTR: { name: "Nektar Therapeutics",    price: 3.20, volatility: 0.10, bias: 0.005, category: "penny",    sector: "Biotech",           marketCapBillions: 0.55, floatMillions: 145,  shortInterestBase: 22.0, institutionalOwnership: 45,  beta: 4.2 },
  PRAX: { name: "Praxis Precision Med",   price: 42,   volatility: 0.09, bias: 0.007, category: "momentum",  sector: "Biotech",           marketCapBillions: 2.8,  floatMillions: 42,   shortInterestBase: 26.0, institutionalOwnership: 62,  beta: 4.0 },

  // EV & energy disruptors
  FFIE: { name: "Faraday Future",         price: 0.38, volatility: 0.15, bias: -0.01,  category: "penny",   sector: "Electric Vehicles", marketCapBillions: 0.08, floatMillions: 320,  shortInterestBase: 45.0, institutionalOwnership: 5,   beta: 6.5 },
  SOLO: { name: "Electrameccanica",       price: 0.55, volatility: 0.13, bias: -0.005, category: "penny",   sector: "Electric Vehicles", marketCapBillions: 0.04, floatMillions: 42,   shortInterestBase: 22.0, institutionalOwnership: 10,  beta: 5.0 },
  VFS:  { name: "VinFast Auto",           price: 3.10, volatility: 0.11, bias: -0.004, category: "penny",   sector: "Electric Vehicles", marketCapBillions: 7.2,  floatMillions: 25,   shortInterestBase: 38.0, institutionalOwnership: 12,  beta: 5.8 },

  // Space & defense high-beta
  MNTS: { name: "Momentus Inc",           price: 0.62, volatility: 0.14, bias: -0.006, category: "penny",   sector: "Space",             marketCapBillions: 0.02, floatMillions: 18,   shortInterestBase: 28.0, institutionalOwnership: 8,   beta: 6.0 },
  ASTR: { name: "Astra Space",            price: 0.48, volatility: 0.12, bias: -0.008, category: "penny",   sector: "Space",             marketCapBillions: 0.05, floatMillions: 285,  shortInterestBase: 25.0, institutionalOwnership: 10,  beta: 5.5 },

  // High-beta fintech & payments
  OPEN: { name: "Opendoor Technologies",  price: 2.20, volatility: 0.075, bias: -0.003, category: "penny",  sector: "PropTech",          marketCapBillions: 1.0,  floatMillions: 410,  shortInterestBase: 20.0, institutionalOwnership: 42,  beta: 3.5 },
  HOOD: { name: "Robinhood Markets",      price: 22,   volatility: 0.055, bias: 0.003, category: "momentum", sector: "Fintech",          marketCapBillions: 19.5, floatMillions: 420,  shortInterestBase: 12.5, institutionalOwnership: 48,  beta: 2.8 },
  COUR: { name: "Coursera Inc",           price: 6.80, volatility: 0.065, bias: 0.002, category: "momentum", sector: "EdTech",           marketCapBillions: 1.2,  floatMillions: 145,  shortInterestBase: 14.0, institutionalOwnership: 55,  beta: 2.5 },
  MAPS: { name: "WM Technology",          price: 1.85, volatility: 0.095, bias: -0.003, category: "penny",  sector: "Cannabis Tech",     marketCapBillions: 0.18, floatMillions: 55,   shortInterestBase: 30.0, institutionalOwnership: 20,  beta: 4.5 },

  // ──────────────────────────────────────────────────────
  // SECTOR ETFs — broad market + leveraged movers
  // ──────────────────────────────────────────────────────
  QQQ:  { name: "Invesco Nasdaq 100 ETF",   price: 475,  volatility: 0.018, bias: 0.001,  category: "momentum", sector: "ETF",          marketCapBillions: 290,  floatMillions: 610000, shortInterestBase: 0.5,  institutionalOwnership: 55, beta: 1.0 },
  SPY:  { name: "SPDR S&P 500 ETF",         price: 565,  volatility: 0.014, bias: 0.001,  category: "momentum", sector: "ETF",          marketCapBillions: 580,  floatMillions: 1020000, shortInterestBase: 0.3, institutionalOwnership: 60, beta: 1.0 },
  XLK:  { name: "Technology Select SPDR",   price: 225,  volatility: 0.020, bias: 0.001,  category: "momentum", sector: "ETF",          marketCapBillions: 65,   floatMillions: 290000, shortInterestBase: 0.4,  institutionalOwnership: 62, beta: 1.1 },
  XLF:  { name: "Financial Select SPDR",    price: 48,   volatility: 0.016, bias: 0.001,  category: "momentum", sector: "ETF",          marketCapBillions: 38,   floatMillions: 800000, shortInterestBase: 0.3,  institutionalOwnership: 58, beta: 1.0 },
  XLE:  { name: "Energy Select SPDR",       price: 88,   volatility: 0.022, bias: 0.001,  category: "momentum", sector: "ETF",          marketCapBillions: 29,   floatMillions: 330000, shortInterestBase: 0.4,  institutionalOwnership: 52, beta: 1.0 },
  XLV:  { name: "Health Care Select SPDR",  price: 145,  volatility: 0.015, bias: 0.001,  category: "momentum", sector: "ETF",          marketCapBillions: 35,   floatMillions: 240000, shortInterestBase: 0.3,  institutionalOwnership: 60, beta: 0.9 },
  XLI:  { name: "Industrial Select SPDR",   price: 135,  volatility: 0.016, bias: 0.001,  category: "momentum", sector: "ETF",          marketCapBillions: 22,   floatMillions: 160000, shortInterestBase: 0.3,  institutionalOwnership: 58, beta: 1.0 },
  SOXL: { name: "Direxion Semi Bull 3X",    price: 28,   volatility: 0.075, bias: 0.003,  category: "momentum", sector: "Leveraged ETF", marketCapBillions: 8.5,  floatMillions: 300,    shortInterestBase: 8.5,  institutionalOwnership: 28, beta: 3.0 },
  TQQQ: { name: "ProShares UltraPro QQQ",   price: 72,   volatility: 0.055, bias: 0.002,  category: "momentum", sector: "Leveraged ETF", marketCapBillions: 21,   floatMillions: 290,    shortInterestBase: 6.5,  institutionalOwnership: 30, beta: 2.8 },
  ARKK: { name: "ARK Innovation ETF",       price: 52,   volatility: 0.038, bias: 0.003,  category: "momentum", sector: "ETF",          marketCapBillions: 8.2,  floatMillions: 158,    shortInterestBase: 14.5, institutionalOwnership: 25, beta: 2.0 },

  // ──────────────────────────────────────────────────────
  // CONSUMER & MEDIA — high-revenue growth leaders
  // ──────────────────────────────────────────────────────
  NFLX: { name: "Netflix Inc",              price: 1040, volatility: 0.030, bias: 0.003,  category: "momentum", sector: "Streaming",     marketCapBillions: 448,  floatMillions: 420,    shortInterestBase: 2.8,  institutionalOwnership: 82, beta: 1.4 },
  UBER: { name: "Uber Technologies",        price: 78,   volatility: 0.030, bias: 0.003,  category: "momentum", sector: "Mobility",      marketCapBillions: 162,  floatMillions: 2060,   shortInterestBase: 3.5,  institutionalOwnership: 72, beta: 1.5 },
  ABNB: { name: "Airbnb Inc",               price: 138,  volatility: 0.032, bias: 0.002,  category: "momentum", sector: "Travel Tech",   marketCapBillions: 88,   floatMillions: 625,    shortInterestBase: 4.2,  institutionalOwnership: 68, beta: 1.5 },
  DIS:  { name: "Walt Disney Co",           price: 104,  volatility: 0.022, bias: 0.001,  category: "momentum", sector: "Entertainment", marketCapBillions: 190,  floatMillions: 1820,   shortInterestBase: 1.8,  institutionalOwnership: 68, beta: 1.1 },
  SPOT: { name: "Spotify Technology",       price: 590,  volatility: 0.038, bias: 0.004,  category: "momentum", sector: "Music Streaming", marketCapBillions: 118, floatMillions: 192,   shortInterestBase: 5.2,  institutionalOwnership: 72, beta: 1.8 },

  // ──────────────────────────────────────────────────────
  // HEALTHCARE & PHARMA — defensive + high-beta biotech
  // ──────────────────────────────────────────────────────
  LLY:  { name: "Eli Lilly and Co",         price: 840,  volatility: 0.025, bias: 0.002,  category: "momentum", sector: "Pharma",        marketCapBillions: 795,  floatMillions: 950,    shortInterestBase: 1.2,  institutionalOwnership: 82, beta: 0.8 },
  UNH:  { name: "UnitedHealth Group",        price: 580,  volatility: 0.020, bias: 0.002,  category: "momentum", sector: "Health Ins",    marketCapBillions: 538,  floatMillions: 930,    shortInterestBase: 0.9,  institutionalOwnership: 88, beta: 0.7 },
  PFE:  { name: "Pfizer Inc",               price: 27,   volatility: 0.022, bias: 0.001,  category: "momentum", sector: "Pharma",        marketCapBillions: 153,  floatMillions: 5690,   shortInterestBase: 1.5,  institutionalOwnership: 72, beta: 0.6 },
  ABBV: { name: "AbbVie Inc",               price: 196,  volatility: 0.020, bias: 0.002,  category: "momentum", sector: "Pharma",        marketCapBillions: 346,  floatMillions: 1770,   shortInterestBase: 1.1,  institutionalOwnership: 78, beta: 0.8 },
  MRNA: { name: "Moderna Inc",              price: 34,   volatility: 0.055, bias: 0.001,  category: "momentum", sector: "Biotech",       marketCapBillions: 13.5, floatMillions: 382,    shortInterestBase: 12.5, institutionalOwnership: 65, beta: 2.0 },

  // ──────────────────────────────────────────────────────
  // ENERGY — oil majors & services
  // ──────────────────────────────────────────────────────
  XOM:  { name: "Exxon Mobil Corp",         price: 110,  volatility: 0.018, bias: 0.001,  category: "momentum", sector: "Oil & Gas",     marketCapBillions: 478,  floatMillions: 4300,   shortInterestBase: 0.8,  institutionalOwnership: 62, beta: 0.9 },
  CVX:  { name: "Chevron Corp",             price: 148,  volatility: 0.018, bias: 0.001,  category: "momentum", sector: "Oil & Gas",     marketCapBillions: 264,  floatMillions: 1780,   shortInterestBase: 0.9,  institutionalOwnership: 65, beta: 0.9 },
  OXY:  { name: "Occidental Petroleum",     price: 43,   volatility: 0.028, bias: 0.002,  category: "momentum", sector: "Oil & Gas",     marketCapBillions: 38,   floatMillions: 880,    shortInterestBase: 3.5,  institutionalOwnership: 62, beta: 1.5 },
  SLB:  { name: "SLB (Schlumberger)",       price: 40,   volatility: 0.025, bias: 0.002,  category: "momentum", sector: "Oil Services",  marketCapBillions: 57,   floatMillions: 1420,   shortInterestBase: 1.8,  institutionalOwnership: 72, beta: 1.4 },

  // ──────────────────────────────────────────────────────
  // FINANCIALS — banks & payments
  // ──────────────────────────────────────────────────────
  JPM:  { name: "JPMorgan Chase",           price: 248,  volatility: 0.018, bias: 0.002,  category: "momentum", sector: "Banking",       marketCapBillions: 716,  floatMillions: 2880,   shortInterestBase: 0.6,  institutionalOwnership: 72, beta: 1.1 },
  BAC:  { name: "Bank of America",          price: 46,   volatility: 0.020, bias: 0.001,  category: "momentum", sector: "Banking",       marketCapBillions: 356,  floatMillions: 7720,   shortInterestBase: 0.7,  institutionalOwnership: 68, beta: 1.3 },
  GS:   { name: "Goldman Sachs",            price: 582,  volatility: 0.022, bias: 0.002,  category: "momentum", sector: "Investment Bank", marketCapBillions: 194, floatMillions: 330,   shortInterestBase: 1.2,  institutionalOwnership: 80, beta: 1.3 },
  MS:   { name: "Morgan Stanley",           price: 120,  volatility: 0.020, bias: 0.002,  category: "momentum", sector: "Investment Bank", marketCapBillions: 206, floatMillions: 1710,  shortInterestBase: 0.8,  institutionalOwnership: 78, beta: 1.2 },
  V:    { name: "Visa Inc",                 price: 348,  volatility: 0.016, bias: 0.002,  category: "momentum", sector: "Payments",      marketCapBillions: 716,  floatMillions: 2050,   shortInterestBase: 0.5,  institutionalOwnership: 88, beta: 1.0 },
  MA:   { name: "Mastercard Inc",           price: 548,  volatility: 0.016, bias: 0.002,  category: "momentum", sector: "Payments",      marketCapBillions: 524,  floatMillions: 960,    shortInterestBase: 0.5,  institutionalOwnership: 90, beta: 1.1 },
  PYPL: { name: "PayPal Holdings",          price: 72,   volatility: 0.032, bias: 0.002,  category: "momentum", sector: "Payments",      marketCapBillions: 78,   floatMillions: 1080,   shortInterestBase: 2.8,  institutionalOwnership: 78, beta: 1.6 },

  // ──────────────────────────────────────────────────────
  // CRYPTO — 24/7, max volatility, money printer fuel
  // ──────────────────────────────────────────────────────
  BTC:   { name: "Bitcoin",           price: 83200, volatility: 0.040, bias: 0.006, category: "crypto", sector: "Crypto", marketCapBillions: 1640, floatMillions: 19500, shortInterestBase: 0.8, institutionalOwnership: 55, beta: 1.8, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 1 },
  ETH:   { name: "Ethereum",          price: 1820,  volatility: 0.055, bias: 0.005, category: "crypto", sector: "Crypto", marketCapBillions: 218,  floatMillions: 120000, shortInterestBase: 1.2, institutionalOwnership: 45, beta: 2.1, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.01 },
  SOL:   { name: "Solana",            price: 128,   volatility: 0.075, bias: 0.007, category: "crypto", sector: "Crypto", marketCapBillions: 66,   floatMillions: 520,    shortInterestBase: 2.1, institutionalOwnership: 38, beta: 2.8, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.01 },
  BNB:   { name: "Binance Coin",      price: 595,   volatility: 0.050, bias: 0.004, category: "crypto", sector: "Crypto", marketCapBillions: 86,   floatMillions: 145,    shortInterestBase: 0.9, institutionalOwnership: 42, beta: 2.2, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.01 },
  XRP:   { name: "Ripple XRP",        price: 2.14,  volatility: 0.080, bias: 0.005, category: "crypto", sector: "Crypto", marketCapBillions: 123,  floatMillions: 57500,  shortInterestBase: 1.5, institutionalOwnership: 22, beta: 2.5, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0001 },
  ADA:   { name: "Cardano",           price: 0.682, volatility: 0.085, bias: 0.003, category: "crypto", sector: "Crypto", marketCapBillions: 24,   floatMillions: 35200,  shortInterestBase: 2.0, institutionalOwnership: 18, beta: 2.7, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0001 },
  DOGE:  { name: "Dogecoin",          price: 0.162, volatility: 0.110, bias: 0.002, category: "crypto", sector: "Crypto", marketCapBillions: 24,   floatMillions: 142000, shortInterestBase: 3.5, institutionalOwnership: 12, beta: 3.5, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.00001 },
  AVAX:  { name: "Avalanche",         price: 22.4,  volatility: 0.095, bias: 0.004, category: "crypto", sector: "Crypto", marketCapBillions: 9.4,  floatMillions: 420,    shortInterestBase: 2.8, institutionalOwnership: 28, beta: 3.0, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.001 },
  LINK:  { name: "Chainlink",         price: 13.2,  volatility: 0.090, bias: 0.005, category: "crypto", sector: "Crypto", marketCapBillions: 8.2,  floatMillions: 620,    shortInterestBase: 3.2, institutionalOwnership: 32, beta: 2.9, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.001 },
  MATIC: { name: "Polygon",           price: 0.385, volatility: 0.105, bias: 0.003, category: "crypto", sector: "Crypto", marketCapBillions: 3.8,  floatMillions: 9800,   shortInterestBase: 4.1, institutionalOwnership: 22, beta: 3.2, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0001 },
  DOT:   { name: "Polkadot",          price: 4.82,  volatility: 0.095, bias: 0.003, category: "crypto", sector: "Crypto", marketCapBillions: 7.2,  floatMillions: 1490,   shortInterestBase: 3.8, institutionalOwnership: 25, beta: 3.0, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.001 },
  PEPE:  { name: "Pepe",              price: 0.0000102, volatility: 0.180, bias: 0.001, category: "crypto", sector: "Crypto", marketCapBillions: 4.3, floatMillions: 420690, shortInterestBase: 8.5, institutionalOwnership: 5, beta: 5.5, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0000001 },
  WIF:   { name: "dogwifhat",         price: 1.42,  volatility: 0.150, bias: 0.002, category: "crypto", sector: "Crypto", marketCapBillions: 1.4,  floatMillions: 998,    shortInterestBase: 9.2, institutionalOwnership: 8,  beta: 5.0, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0001 },
  SUI:   { name: "Sui",               price: 2.85,  volatility: 0.120, bias: 0.006, category: "crypto", sector: "Crypto", marketCapBillions: 8.9,  floatMillions: 3120,   shortInterestBase: 5.2, institutionalOwnership: 30, beta: 3.8, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0001 },
  TON:   { name: "Toncoin",           price: 3.18,  volatility: 0.100, bias: 0.004, category: "crypto", sector: "Crypto", marketCapBillions: 7.8,  floatMillions: 2450,   shortInterestBase: 4.5, institutionalOwnership: 20, beta: 3.3, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0001 },
  INJ:   { name: "Injective",         price: 14.6,  volatility: 0.130, bias: 0.007, category: "crypto", sector: "Crypto", marketCapBillions: 1.4,  floatMillions: 94,     shortInterestBase: 12.0, institutionalOwnership: 35, beta: 4.2, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.001 },
  BONK:  { name: "Bonk",              price: 0.0000185, volatility: 0.200, bias: 0.001, category: "crypto", sector: "Crypto", marketCapBillions: 1.3, floatMillions: 69420, shortInterestBase: 11.0, institutionalOwnership: 4, beta: 6.0, marketType: "crypto", exchange: "Binance", tradingHours: "24/7", pipSize: 0.0000001 },

  // ──────────────────────────────────────────────────────
  // FOREX — 24/5, pip-based, massive liquidity
  // ──────────────────────────────────────────────────────
  EURUSD: { name: "Euro / US Dollar",       price: 1.0842, volatility: 0.006, bias: 0.0002, category: "forex", sector: "Major Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.3, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  GBPUSD: { name: "British Pound / USD",     price: 1.2988, volatility: 0.007, bias: 0.0001, category: "forex", sector: "Major Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.4, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  USDJPY: { name: "USD / Japanese Yen",      price: 149.85, volatility: 0.005, bias: 0.0001, category: "forex", sector: "Major Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.3, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.01 },
  AUDUSD: { name: "Australian $ / USD",      price: 0.6318, volatility: 0.007, bias: 0.0001, category: "forex", sector: "Major Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.5, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  USDCAD: { name: "USD / Canadian Dollar",   price: 1.3648, volatility: 0.006, bias: 0.0001, category: "forex", sector: "Major Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.4, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  USDCHF: { name: "USD / Swiss Franc",       price: 0.8852, volatility: 0.005, bias: -0.0001, category: "forex", sector: "Major Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.2, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  NZDUSD: { name: "New Zealand $ / USD",     price: 0.5724, volatility: 0.008, bias: 0.0001, category: "forex", sector: "Major Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.5, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  EURGBP: { name: "Euro / British Pound",    price: 0.8348, volatility: 0.005, bias: 0.0000, category: "forex", sector: "Cross Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.3, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  EURJPY: { name: "Euro / Japanese Yen",     price: 162.40, volatility: 0.007, bias: 0.0001, category: "forex", sector: "Cross Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.4, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.01 },
  GBPJPY: { name: "GBP / Japanese Yen",      price: 194.80, volatility: 0.009, bias: 0.0001, category: "forex", sector: "Cross Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.5, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.01 },
  XAUUSD: { name: "Gold / USD",              price: 3108,   volatility: 0.012, bias: 0.0005, category: "forex", sector: "Metals",      marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.6, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.01 },
  XAGUSD: { name: "Silver / USD",            price: 34.2,   volatility: 0.020, bias: 0.0004, category: "forex", sector: "Metals",      marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.8, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.001 },
  USDZAR: { name: "USD / South African Rand", price: 18.52, volatility: 0.015, bias: 0.0002, category: "forex", sector: "Exotic Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.9, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  USDMXN: { name: "USD / Mexican Peso",      price: 20.18,  volatility: 0.012, bias: 0.0002, category: "forex", sector: "Exotic Pairs", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.8, marketType: "forex", exchange: "Forex", tradingHours: "24/5", pipSize: 0.0001 },
  BTCUSD: { name: "Bitcoin / USD (FX)",      price: 83150,  volatility: 0.042, bias: 0.006,  category: "forex", sector: "Crypto FX",  marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.8, marketType: "forex", exchange: "Forex", tradingHours: "24/7", pipSize: 1 },

  // ──────────────────────────────────────────────────────
  // COMMODITIES — energy, metals, agriculture
  // ──────────────────────────────────────────────────────
  OIL:   { name: "Crude Oil WTI",      price: 71.2,  volatility: 0.025, bias: 0.001, category: "commodity", sector: "Energy",     marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.2, marketType: "commodity", exchange: "NYMEX", tradingHours: "24/5", pipSize: 0.01 },
  BRENT: { name: "Brent Crude Oil",    price: 74.8,  volatility: 0.024, bias: 0.001, category: "commodity", sector: "Energy",     marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.1, marketType: "commodity", exchange: "ICE",   tradingHours: "24/5", pipSize: 0.01 },
  NATGAS: { name: "Natural Gas",       price: 3.82,  volatility: 0.040, bias: 0.001, category: "commodity", sector: "Energy",     marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.5, marketType: "commodity", exchange: "NYMEX", tradingHours: "24/5", pipSize: 0.001 },
  GOLD:  { name: "Gold Futures",       price: 3112,  volatility: 0.012, bias: 0.0005, category: "commodity", sector: "Metals",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.6, marketType: "commodity", exchange: "COMEX", tradingHours: "24/5", pipSize: 0.1 },
  SILVER: { name: "Silver Futures",    price: 34.5,  volatility: 0.020, bias: 0.0004, category: "commodity", sector: "Metals",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.8, marketType: "commodity", exchange: "COMEX", tradingHours: "24/5", pipSize: 0.005 },
  COPPER: { name: "Copper Futures",    price: 4.68,  volatility: 0.018, bias: 0.0003, category: "commodity", sector: "Metals",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.9, marketType: "commodity", exchange: "COMEX", tradingHours: "24/5", pipSize: 0.0005 },
  PLAT:  { name: "Platinum",           price: 932,   volatility: 0.018, bias: 0.0003, category: "commodity", sector: "Metals",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.7, marketType: "commodity", exchange: "NYMEX", tradingHours: "24/5", pipSize: 0.1 },
  WHEAT: { name: "Wheat Futures",      price: 542,   volatility: 0.022, bias: 0.0001, category: "commodity", sector: "Agriculture", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.5, marketType: "commodity", exchange: "CBOT",  tradingHours: "market_hours", pipSize: 0.25 },
  CORN:  { name: "Corn Futures",       price: 445,   volatility: 0.020, bias: 0.0001, category: "commodity", sector: "Agriculture", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.4, marketType: "commodity", exchange: "CBOT",  tradingHours: "market_hours", pipSize: 0.25 },
  COCOA: { name: "Cocoa Futures",      price: 8840,  volatility: 0.035, bias: 0.002,  category: "commodity", sector: "Agriculture", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.6, marketType: "commodity", exchange: "ICE",   tradingHours: "market_hours", pipSize: 1 },
  COFFEE: { name: "Coffee Futures",    price: 338,   volatility: 0.030, bias: 0.001,  category: "commodity", sector: "Agriculture", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.5, marketType: "commodity", exchange: "ICE",   tradingHours: "market_hours", pipSize: 0.05 },
  URAN:  { name: "Uranium",            price: 65.8,  volatility: 0.028, bias: 0.002,  category: "commodity", sector: "Energy",     marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.3, marketType: "commodity", exchange: "OTC",   tradingHours: "market_hours", pipSize: 0.1 },

  // ──────────────────────────────────────────────────────
  // INDICES — market-wide momentum plays
  // ──────────────────────────────────────────────────────
  SPX:   { name: "S&P 500",            price: 5155,  volatility: 0.012, bias: 0.0005, category: "index", sector: "US Indices",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.0, marketType: "index", exchange: "CME",   tradingHours: "market_hours", pipSize: 0.25 },
  NDX:   { name: "Nasdaq 100",         price: 17820, volatility: 0.015, bias: 0.0007, category: "index", sector: "US Indices",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.3, marketType: "index", exchange: "CME",   tradingHours: "market_hours", pipSize: 0.25 },
  DJI:   { name: "Dow Jones 30",       price: 41200, volatility: 0.010, bias: 0.0004, category: "index", sector: "US Indices",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.8, marketType: "index", exchange: "CME",   tradingHours: "market_hours", pipSize: 1 },
  RUT:   { name: "Russell 2000",       price: 1925,  volatility: 0.018, bias: 0.0006, category: "index", sector: "US Indices",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 1.2, marketType: "index", exchange: "CME",   tradingHours: "market_hours", pipSize: 0.1 },
  VIX:   { name: "Volatility Index",   price: 21.8,  volatility: 0.080, bias: -0.001, category: "index", sector: "Volatility",   marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: -1.2, marketType: "index", exchange: "CBOE",  tradingHours: "market_hours", pipSize: 0.01 },
  DAX:   { name: "Germany DAX 40",     price: 21450, volatility: 0.014, bias: 0.0005, category: "index", sector: "EU Indices",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.9, marketType: "index", exchange: "EUREX", tradingHours: "market_hours", pipSize: 0.5 },
  FTSE:  { name: "FTSE 100",           price: 8620,  volatility: 0.011, bias: 0.0003, category: "index", sector: "UK Indices",    marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.7, marketType: "index", exchange: "LSE",   tradingHours: "market_hours", pipSize: 0.5 },
  N225:  { name: "Nikkei 225",         price: 35800, volatility: 0.015, bias: 0.0004, category: "index", sector: "Asia Indices",  marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.8, marketType: "index", exchange: "OSE",   tradingHours: "market_hours", pipSize: 5 },
  HSI:   { name: "Hang Seng",          price: 22850, volatility: 0.018, bias: 0.0002, category: "index", sector: "Asia Indices",  marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: 0.9, marketType: "index", exchange: "HKEX",  tradingHours: "market_hours", pipSize: 1 },
  DXY:   { name: "US Dollar Index",    price: 104.2, volatility: 0.005, bias: 0.0001, category: "index", sector: "Currency Index", marketCapBillions: 0, floatMillions: 0, shortInterestBase: 0, institutionalOwnership: 0, beta: -0.3, marketType: "index", exchange: "ICE",   tradingHours: "24/5", pipSize: 0.001 },
};

const ANALYST_FIRMS = [
  "Goldman Sachs", "Morgan Stanley", "JP Morgan", "Bank of America",
  "Citigroup", "UBS", "Barclays", "Deutsche Bank", "Wells Fargo",
  "Jefferies", "Piper Sandler", "Needham", "Wedbush", "Raymond James"
];

const CATALYST_TYPES = [
  { type: "earnings", titles: ["Beat Q1 estimates by 15%", "Revenue guidance raised", "EPS miss on higher spending", "Record quarterly revenue"] },
  { type: "partnership", titles: ["New strategic partnership announced", "Signed multi-year contract", "Government contract awarded", "Joint venture formed"] },
  { type: "product", titles: ["New product launch", "FDA approval received", "Patent granted", "Major platform update released"] },
  { type: "analyst", titles: ["Multiple analyst upgrades", "Added to institutional portfolio", "Price target raised 25%", "Downgrade on valuation concerns"] },
  { type: "regulatory", titles: ["Regulatory approval secured", "Compliance milestone achieved", "New legislation favorable", "Investigation closed"] },
  { type: "insider", titles: ["CEO purchased $2M shares", "Director increased stake", "CFO sold planned shares", "10b5-1 plan established"] },
];

function generateHistory(ticker: string, rand: () => number): DailyCandle[] {
  const info = STOCK_INFO[ticker];
  const candles: DailyCandle[] = [];
  let price = info.price * (0.9 + rand() * 0.15);

  for (let i = 29; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    const dateStr = date.toISOString().split("T")[0];

    const change = (rand() - 0.48 + info.bias) * info.volatility * price;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) * (1 + rand() * 0.01);
    const low = Math.min(open, close) * (1 - rand() * 0.01);
    const baseVol = info.category === "penny"
      ? 5_000_000 + rand() * 20_000_000
      : ticker === "NVDA" ? 300_000_000 : 50_000_000 + rand() * 80_000_000;
    const volume = Math.round(baseVol * (0.6 + rand() * 0.8));

    candles.push({
      date: dateStr,
      open: Math.round(open * 100) / 100,
      high: Math.round(high * 100) / 100,
      low: Math.round(low * 100) / 100,
      close: Math.round(close * 100) / 100,
      volume,
    });

    price = close;
  }

  // Scale to match target price
  const lastCandle = candles[candles.length - 1];
  const scaleFactor = info.price / lastCandle.close;
  for (const c of candles) {
    c.open = Math.round(c.open * scaleFactor * 100) / 100;
    c.high = Math.round(c.high * scaleFactor * 100) / 100;
    c.low = Math.round(c.low * scaleFactor * 100) / 100;
    c.close = Math.round(c.close * scaleFactor * 100) / 100;
  }

  // Add MA and Bollinger data
  for (let i = 0; i < candles.length; i++) {
    if (i >= 19) {
      const slice20 = candles.slice(i - 19, i + 1);
      candles[i].ma20 = Math.round(slice20.reduce((s, c) => s + c.close, 0) / 20 * 100) / 100;
    }
    if (i >= 29) {
      // Use full 30 candles for rough 50d MA approximation
      const sliceAll = candles.slice(0, i + 1);
      candles[i].ma50 = Math.round(sliceAll.reduce((s, c) => s + c.close, 0) / sliceAll.length * 100) / 100;
    }
    if (i >= 19 && candles[i].ma20) {
      const slice20 = candles.slice(i - 19, i + 1);
      const mean = candles[i].ma20!;
      const stddev = Math.sqrt(slice20.reduce((s, c) => s + (c.close - mean) ** 2, 0) / 20);
      candles[i].bollingerUpper = Math.round((mean + 2 * stddev) * 100) / 100;
      candles[i].bollingerLower = Math.round((mean - 2 * stddev) * 100) / 100;
    }
  }

  return candles;
}

function generateAnalystActions(ticker: string, rand: () => number, bias: number): AnalystAction[] {
  const info = STOCK_INFO[ticker];
  const actions: AnalystAction[] = [];
  const numActions = 3 + Math.floor(rand() * 4);

  for (let i = 0; i < numActions; i++) {
    const daysAgo = Math.floor(rand() * 30);
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const firm = ANALYST_FIRMS[Math.floor(rand() * ANALYST_FIRMS.length)];

    let rating: string;
    let action: string;
    const r = rand() * 100;
    if (r < bias * 0.7) {
      rating = "Overweight";
      action = rand() > 0.5 ? "Upgrade" : "Reiterate";
    } else if (r < bias) {
      rating = "Buy";
      action = "Initiate";
    } else if (r < bias + 20) {
      rating = "Equal Weight";
      action = "Maintain";
    } else {
      rating = "Underweight";
      action = rand() > 0.5 ? "Downgrade" : "Reiterate";
    }

    const pt = Math.round(info.price * (0.85 + rand() * 0.4));

    actions.push({
      date: date.toISOString().split("T")[0],
      firm,
      action,
      rating,
      priceTarget: pt,
    });
  }

  return actions.sort((a, b) => b.date.localeCompare(a.date));
}

function generateCatalystTimeline(ticker: string, rand: () => number): CatalystEvent[] {
  const events: CatalystEvent[] = [];
  const numEvents = 2 + Math.floor(rand() * 4);

  for (let i = 0; i < numEvents; i++) {
    const daysAgo = Math.floor(rand() * 30);
    const date = new Date();
    date.setDate(date.getDate() - daysAgo);
    const catType = CATALYST_TYPES[Math.floor(rand() * CATALYST_TYPES.length)];
    const title = catType.titles[Math.floor(rand() * catType.titles.length)];
    const impacts: ("positive" | "negative" | "neutral")[] = ["positive", "positive", "neutral", "negative"];
    const impact = impacts[Math.floor(rand() * impacts.length)];

    events.push({
      date: date.toISOString().split("T")[0],
      type: catType.type,
      title,
      impact,
    });
  }

  return events.sort((a, b) => b.date.localeCompare(a.date));
}

function computeRSI(candles: DailyCandle[]): number {
  if (candles.length < 15) return 50;
  const changes = candles.slice(-15).map((c, i, arr) =>
    i === 0 ? 0 : c.close - arr[i - 1].close
  ).slice(1);

  const gains = changes.filter(c => c > 0);
  const losses = changes.filter(c => c < 0).map(c => Math.abs(c));
  const avgGain = gains.length > 0 ? gains.reduce((s, g) => s + g, 0) / 14 : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, l) => s + l, 0) / 14 : 0.001;
  const rs = avgGain / avgLoss;
  return Math.round(100 - (100 / (1 + rs)));
}

export function generateAllStocks(): StockData[] {
  const stocks: StockData[] = [];

  for (const ticker of Object.keys(STOCK_INFO)) {
    const rand = seededRandom(ticker.split("").reduce((a, c) => a + c.charCodeAt(0), 0) * 137);
    const info = STOCK_INFO[ticker];
    const history = generateHistory(ticker, rand);

    const lastCandle = history[history.length - 1];
    const prevCandle = history[history.length - 2];
    const price = lastCandle.close;
    const previousClose = prevCandle.close;
    const dayChange = Math.round((price - previousClose) * 100) / 100;
    const dayChangePercent = Math.round((dayChange / previousClose) * 10000) / 100;

    // Week and month changes
    const weekAgo = history.length >= 7 ? history[history.length - 6] : history[0];
    const monthAgo = history[0];
    const weekChangePercent = Math.round(((price - weekAgo.close) / weekAgo.close) * 10000) / 100;
    const monthChangePercent = Math.round(((price - monthAgo.close) / monthAgo.close) * 10000) / 100;

    const avgVolume = Math.round(history.slice(-20).reduce((s, c) => s + c.volume, 0) / 20);
    const volume = lastCandle.volume;

    // 12 metrics
    const rsi = computeRSI(history);
    const macdSignal = dayChangePercent > 0.5 ? 20 : dayChangePercent < -0.5 ? -20 : 0;

    const ma20 = lastCandle.ma20 || price;
    const ma50 = lastCandle.ma50 || price;
    const maAlignment = price > ma20 && ma20 > ma50 ? 30 : price < ma20 && ma20 < ma50 ? -30 : 0;

    const volumeSpikeRatio = Math.round((volume / avgVolume) * 100) / 100;

    // Bollinger position
    const bUpper = lastCandle.bollingerUpper || price * 1.05;
    const bLower = lastCandle.bollingerLower || price * 0.95;
    const bollingerPosition = Math.max(0, Math.min(100, Math.round(((price - bLower) / (bUpper - bLower)) * 100)));

    // Short interest with jitter
    const shortInterestPct = Math.round((info.shortInterestBase + (rand() - 0.5) * 4) * 10) / 10;
    const daysToCover = Math.round((shortInterestPct / 100 * info.floatMillions * 1_000_000 / avgVolume) * 10) / 10;
    const floatShares = info.floatMillions;

    // Catalyst score
    const catalystScore = Math.round(rand() * 100);
    // Sentiment
    const sentimentScore = Math.round(30 + rand() * 60);
    // Institutional ownership
    const institutionalOwnershipPct = Math.round(info.institutionalOwnership + (rand() - 0.5) * 10);
    // Insider activity
    const insiderActivity = Math.round((rand() - 0.4) * 80);

    // Derive momentum, volume, analyst scores
    const momentumBias = info.bias > 0.002 ? 15 : info.bias < -0.002 ? -15 : 0;
    const momentumScore = Math.max(0, Math.min(100,
      Math.round(50 + momentumBias + (rsi - 50) * 0.3 + maAlignment * 0.5 + macdSignal * 0.3 + (rand() - 0.5) * 20)
    ));
    const volumeScore = Math.max(0, Math.min(100,
      Math.round(30 + Math.min(volumeSpikeRatio * 15, 50) + (rand() - 0.5) * 15)
    ));
    const analystScore = Math.max(0, Math.min(100,
      Math.round(40 + institutionalOwnershipPct * 0.3 + insiderActivity * 0.15 + (rand() - 0.5) * 20)
    ));

    // Composite score (general - not scanner-specific)
    const compositeScore = Math.round(
      momentumScore * 0.35 + volumeScore * 0.20 + sentimentScore * 0.25 + analystScore * 0.20
    );

    let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
    if (compositeScore >= 65) signal = "BUY";
    else if (compositeScore <= 35) signal = "SELL";

    const bullBearRatio = Math.round((sentimentScore / Math.max(1, 100 - sentimentScore)) * 100) / 100;

    const buyRatings = Math.round(analystScore * 0.14);
    const sellRatings = Math.round((100 - analystScore) * 0.06);
    const holdRatings = Math.max(0, 14 - buyRatings - sellRatings);

    const analystActions = generateAnalystActions(ticker, rand, analystScore);
    const catalystTimeline = generateCatalystTimeline(ticker, rand);

    const bullText = signal === "BUY"
      ? `Strong momentum with improving technical indicators. ${ticker} shows consistent buying pressure and institutional accumulation.`
      : signal === "SELL"
        ? `Some contrarian buyers see value at current levels. Watch for potential reversal signals near support.`
        : `Moderate upside potential with stable fundamentals. Position sizing should reflect the mixed signal environment.`;

    const bearText = signal === "SELL"
      ? `Deteriorating technical picture with high-volume selloffs. Key support levels under threat with negative momentum divergence.`
      : signal === "BUY"
        ? `Overbought conditions may lead to near-term pullback. Risk/reward less favorable at current elevated levels.`
        : `Limited catalysts in the near term. Sideways trading likely until next earnings or macro event provides direction.`;

    const fiftyTwoWeekHigh = Math.round(price * (1.15 + rand() * 0.35) * 100) / 100;
    const fiftyTwoWeekLow = Math.round(price * (0.45 + rand() * 0.25) * 100) / 100;

    // Next earnings date
    const earningsDate = new Date();
    earningsDate.setDate(earningsDate.getDate() + 10 + Math.floor(rand() * 50));
    const nextEarnings = earningsDate.toISOString().split("T")[0];

    stocks.push({
      ticker,
      name: info.name,
      price,
      previousClose,
      dayChange,
      dayChangePercent,
      weekChangePercent,
      monthChangePercent,
      volume,
      avgVolume,
      high: lastCandle.high,
      low: lastCandle.low,
      open: lastCandle.open,
      history,
      category: info.category,
      rsi,
      macdSignal,
      maAlignment,
      volumeSpikeRatio,
      bollingerPosition,
      shortInterestPct: Math.max(0, shortInterestPct),
      daysToCover: Math.max(0, daysToCover),
      floatShares,
      catalystScore,
      sentimentScore,
      institutionalOwnershipPct: Math.max(0, Math.min(100, institutionalOwnershipPct)),
      insiderActivity,
      momentumScore,
      volumeScore,
      analystScore,
      compositeScore,
      signal,
      bullBearRatio,
      analystRatings: { buy: buyRatings, hold: holdRatings, sell: sellRatings },
      analystActions,
      sentimentSummary: { bull: bullText, bear: bearText },
      marketCap: info.marketCapBillions * 1_000_000_000,
      beta: info.beta,
      fiftyTwoWeekHigh,
      fiftyTwoWeekLow,
      ma20,
      ma50,
      nextEarnings,
      sector: info.sector,
      catalystTimeline,
      // Multi-market fields
      marketType: (info.marketType ?? "stock") as StockData["marketType"],
      exchange: info.exchange ?? "NYSE",
      tradingHours: (info.tradingHours ?? "market_hours") as StockData["tradingHours"],
      pipSize: info.pipSize ?? 0.01,
      ma20dAlignment: price > ma20 ? "Above" : price < ma20 * 0.98 ? "Below" : "At",
    });
  }

  return stocks.sort((a, b) => b.compositeScore - a.compositeScore);
}

// Scanner scoring functions
export function scorePennyStock(s: StockData): number {
  const floatScore = s.floatShares < 10 ? 100 : s.floatShares < 50 ? 70 : s.floatShares < 200 ? 40 : 20;
  const shortScore = Math.min(100, s.shortInterestPct * 4);
  const volScore = Math.min(100, s.volumeSpikeRatio * 30);
  const catScore = s.catalystScore;
  const momScore = s.momentumScore;
  return Math.round(floatScore * 0.15 + shortScore * 0.20 + volScore * 0.20 + catScore * 0.25 + momScore * 0.20);
}

export function scoreMomentum(s: StockData): number {
  const rsiScore = s.rsi > 50 ? Math.min(100, (s.rsi - 30) * 1.5) : Math.max(0, s.rsi * 1.2);
  const macdScore = s.macdSignal === 20 ? 80 : s.macdSignal === 0 ? 50 : 20;
  const maScore = s.maAlignment === 30 ? 90 : s.maAlignment === 0 ? 50 : 15;
  const volScore = Math.min(100, s.volumeSpikeRatio * 30);
  const bollScore = s.bollingerPosition > 70 ? 80 : s.bollingerPosition > 40 ? 60 : 30;
  const sentScore = s.sentimentScore;
  return Math.round(rsiScore * 0.15 + macdScore * 0.20 + maScore * 0.20 + volScore * 0.15 + bollScore * 0.15 + sentScore * 0.15);
}

export function scoreSqueeze(s: StockData): number {
  const shortScore = Math.min(100, s.shortInterestPct * 3);
  const dtcScore = Math.min(100, s.daysToCover * 15);
  const volScore = Math.min(100, s.volumeSpikeRatio * 30);
  const floatScore = s.floatShares < 50 ? 90 : s.floatShares < 200 ? 60 : s.floatShares < 1000 ? 30 : 10;
  const catScore = s.catalystScore;
  return Math.round(shortScore * 0.30 + dtcScore * 0.25 + volScore * 0.20 + floatScore * 0.15 + catScore * 0.10);
}

export function generateOptionsFlow(stocks: StockData[], rand: () => number): OptionsFlowRow[] {
  const flows: OptionsFlowRow[] = [];
  const selectedStocks = stocks.filter(() => rand() > 0.3).slice(0, 25);

  for (let i = 0; i < selectedStocks.length; i++) {
    const s = selectedStocks[i];
    const isCall = rand() > 0.35;
    const otmMult = isCall ? 1 + rand() * 0.15 : 1 - rand() * 0.15;
    const strike = Math.round(s.price * otmMult * 100) / 100;
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + 7 + Math.floor(rand() * 45));
    const premium = Math.round((s.price * 0.02 + rand() * s.price * 0.08) * 100) / 100;
    const volumeVsOI = Math.round((1 + rand() * 8) * 10) / 10;
    const sentiment = isCall ? "Bullish" as const : "Bearish" as const;
    const flowScore = Math.round(
      Math.min(100, premium * 0.5 + volumeVsOI * 8 + (isCall ? 15 : 5) + rand() * 20)
    );

    let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
    if (flowScore >= 65) signal = "BUY";
    else if (flowScore <= 35) signal = "SELL";

    flows.push({
      rank: i + 1,
      ticker: s.ticker,
      price: s.price,
      contractType: isCall ? "Call" : "Put",
      strike,
      expiry: expiryDate.toISOString().split("T")[0],
      premium,
      volumeVsOI,
      sentiment,
      flowScore,
      signal,
    });
  }

  return flows.sort((a, b) => b.flowScore - a.flowScore).map((f, i) => ({ ...f, rank: i + 1 }));
}

export function generateMarketStatus(rand: () => number): MarketStatus {
  const sp500Price = 5250 + Math.round((rand() - 0.5) * 200);
  const sp500Change = Math.round((rand() - 0.45) * 50 * 100) / 100;
  const sp500ChangePct = Math.round((sp500Change / sp500Price) * 10000) / 100;
  const vix = Math.round((14 + rand() * 18) * 10) / 10;
  const fearGreed = Math.round(30 + rand() * 50);
  const bitcoin = Math.round(62000 + (rand() - 0.5) * 8000);

  let sentiment: "Bullish" | "Bearish" | "Uncertain" = "Uncertain";
  if (fearGreed > 60 && sp500ChangePct > 0) sentiment = "Bullish";
  else if (fearGreed < 35 || sp500ChangePct < -0.5) sentiment = "Bearish";

  // Market close time = 4:00 PM EST today
  const now = new Date();
  const closeTime = new Date(now);
  closeTime.setHours(16, 0, 0, 0);

  return {
    sentiment,
    sp500: { price: sp500Price, change: sp500Change, changePercent: sp500ChangePct },
    vix,
    fearGreed,
    bitcoin,
    marketCloseTime: closeTime.toISOString(),
  };
}
