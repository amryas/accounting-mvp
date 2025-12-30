import express from 'express';
import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ========================================
// Google Sheets Database Client
// ========================================
class SheetsDB {
  constructor() {
    this.doc = null;
    this.sheets = {};
  }

  async init() {
    try {
      // Read service account from JSON file
      const serviceAccountAuth = new JWT({
  email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
  key: process.env.GOOGLE_PRIVATE_KEY,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

      this.doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, serviceAccountAuth);
      await this.doc.loadInfo();

      // Get or create sheets
      this.sheets.inventory = await this.getOrCreateSheet('inventory', ['item', 'qty', 'avg_cost']);
      this.sheets.sales = await this.getOrCreateSheet('sales', ['id', 'date', 'item', 'qty', 'sell_price', 'profit']);
      this.sheets.purchases = await this.getOrCreateSheet('purchases', ['id', 'date', 'item', 'qty', 'buy_price']);
      this.sheets.expenses = await this.getOrCreateSheet('expenses', ['id', 'date', 'title', 'amount']);
      this.sheets.summary = await this.getOrCreateSheet('summary', ['cash', 'total_profit', 'capital']);

      // Initialize summary if empty
      const summaryRows = await this.sheets.summary.getRows();
      if (summaryRows.length === 0) {
        await this.sheets.summary.addRow({ cash: 0, total_profit: 0, capital: 0 });
      }

      console.log('✅ Database connected successfully!');
    } catch (error) {
      console.error('❌ Database connection failed:', error.message);
      throw error;
    }
  }

  async getOrCreateSheet(title, headers) {
    let sheet = this.doc.sheetsByTitle[title];
    if (!sheet) {
      sheet = await this.doc.addSheet({ headerValues: headers, title });
    }
    return sheet;
  }

  async getInventory(item) {
    const rows = await this.sheets.inventory.getRows();
    const row = rows.find(r => r.get('item') === item);
    if (!row) return null;
    return {
      item: row.get('item'),
      qty: parseFloat(row.get('qty')),
      avg_cost: parseFloat(row.get('avg_cost')),
      rowIndex: row._rowNumber
    };
  }

  async setInventory(item, qty, avg_cost) {
    const rows = await this.sheets.inventory.getRows();
    const row = rows.find(r => r.get('item') === item);
    
    if (row) {
      row.set('qty', qty);
      row.set('avg_cost', avg_cost);
      await row.save();
    } else {
      await this.sheets.inventory.addRow({ item, qty, avg_cost });
    }
  }

  async addSale(item, qty, sell_price, profit) {
    await this.sheets.sales.addRow({
      id: Date.now(),
      date: new Date().toISOString(),
      item,
      qty,
      sell_price,
      profit
    });
  }

  async addPurchase(item, qty, buy_price) {
    await this.sheets.purchases.addRow({
      id: Date.now(),
      date: new Date().toISOString(),
      item,
      qty,
      buy_price
    });
  }

  async addExpense(title, amount) {
    await this.sheets.expenses.addRow({
      id: Date.now(),
      date: new Date().toISOString(),
      title,
      amount
    });
  }

  async getSummary() {
    const rows = await this.sheets.summary.getRows();
    if (rows.length === 0) return { cash: 0, total_profit: 0, capital: 0 };
    const row = rows[0];
    return {
      cash: parseFloat(row.get('cash') || 0),
      total_profit: parseFloat(row.get('total_profit') || 0),
      capital: parseFloat(row.get('capital') || 0)
    };
  }

  async updateSummary(cash, total_profit, capital) {
    const rows = await this.sheets.summary.getRows();
    const row = rows[0];
    row.set('cash', cash);
    row.set('total_profit', total_profit);
    row.set('capital', capital);
    await row.save();
  }

  async getSalesData() {
    const rows = await this.sheets.sales.getRows();
    return rows.map(r => ({
      date: new Date(r.get('date')),
      profit: parseFloat(r.get('profit') || 0)
    }));
  }

  async getAllInventory() {
    const rows = await this.sheets.inventory.getRows();
    return rows.map(r => ({
      item: r.get('item'),
      qty: parseFloat(r.get('qty') || 0),
      avg_cost: parseFloat(r.get('avg_cost') || 0)
    }));
  }
}

// ========================================
// Business Logic Engine
// ========================================
class AccountingEngine {
  constructor(db) {
    this.db = db;
  }

  async sell(item, qty, sellPrice) {
    const qtyNum = parseFloat(qty);
    const priceNum = parseFloat(sellPrice);

    if (isNaN(qtyNum) || isNaN(priceNum) || qtyNum <= 0 || priceNum <= 0) {
      return { success: false, message: 'أدخل أرقام صحيحة للكمية والسعر' };
    }

    const stock = await this.db.getInventory(item);
    if (!stock || stock.qty < qtyNum) {
      return { 
        success: false, 
        message: `مخزون غير كافي. المتوفر: ${stock ? stock.qty : 0}` 
      };
    }

    const profit = (priceNum - stock.avg_cost) * qtyNum;
    const revenue = priceNum * qtyNum;

    await this.db.addSale(item, qtyNum, priceNum, profit);
    await this.db.setInventory(item, stock.qty - qtyNum, stock.avg_cost);

    const summary = await this.db.getSummary();
    await this.db.updateSummary(
      summary.cash + revenue,
      summary.total_profit + profit,
      summary.capital
    );

    return {
      success: true,
      message: `✅ تم البيع\n${item}: ${qtyNum} × ${priceNum} ج.م\nالإيراد: ${revenue} ج.م\nالربح: ${profit.toFixed(2)} ج.م\nالمخزون المتبقي: ${(stock.qty - qtyNum).toFixed(0)}`
    };
  }

  async buy(item, qty, buyPrice) {
    const qtyNum = parseFloat(qty);
    const priceNum = parseFloat(buyPrice);

    if (isNaN(qtyNum) || isNaN(priceNum) || qtyNum <= 0 || priceNum <= 0) {
      return { success: false, message: 'أدخل أرقام صحيحة للكمية والسعر' };
    }

    const stock = await this.db.getInventory(item);
    const currentQty = stock ? stock.qty : 0;
    const currentAvgCost = stock ? stock.avg_cost : 0;

    const totalCost = currentQty * currentAvgCost + qtyNum * priceNum;
    const totalQty = currentQty + qtyNum;
    const newAvgCost = totalCost / totalQty;

    await this.db.addPurchase(item, qtyNum, priceNum);
    await this.db.setInventory(item, totalQty, newAvgCost);

    const spent = qtyNum * priceNum;
    const summary = await this.db.getSummary();
    await this.db.updateSummary(
      summary.cash - spent,
      summary.total_profit,
      summary.capital + spent
    );

    return {
      success: true,
      message: `✅ تم الشراء\n${item}: ${qtyNum} × ${priceNum} ج.م\nالإجمالي: ${spent} ج.م\nالمخزون الجديد: ${totalQty.toFixed(0)}\nمتوسط التكلفة: ${newAvgCost.toFixed(2)} ج.م`
    };
  }

  async expense(title, amount) {
    const amountNum = parseFloat(amount);

    if (isNaN(amountNum) || amountNum <= 0) {
      return { success: false, message: 'أدخل مبلغ صحيح' };
    }

    await this.db.addExpense(title, amountNum);

    const summary = await this.db.getSummary();
    await this.db.updateSummary(
      summary.cash - amountNum,
      summary.total_profit - amountNum,
      summary.capital
    );

    return {
      success: true,
      message: `✅ تم تسجيل المصروف\n${title}: ${amountNum} ج.م\nالرصيد المتبقي: ${(summary.cash - amountNum).toFixed(2)} ج.م`
    };
  }

  async stock(item) {
    if (!item) {
      const items = await this.db.getAllInventory();
      if (items.length === 0) {
        return { success: true, message: 'لا يوجد مخزون' };
      }
      const lines = items.map(i => `${i.item}: ${i.qty.toFixed(0)} (${i.avg_cost.toFixed(2)} ج.م)`);
      return {
        success: true,
        message: '📦 المخزون:\n\n' + lines.join('\n')
      };
    }

    const stock = await this.db.getInventory(item);
    if (!stock) {
      return { success: false, message: `المنتج "${item}" غير موجود` };
    }

    return {
      success: true,
      message: `📦 ${item}\nالكمية: ${stock.qty.toFixed(0)}\nمتوسط التكلفة: ${stock.avg_cost.toFixed(2)} ج.م\nالقيمة: ${(stock.qty * stock.avg_cost).toFixed(2)} ج.م`
    };
  }

  async profit() {
    const sales = await this.db.getSalesData();
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);

    const todayProfit = sales
      .filter(s => s.date >= todayStart)
      .reduce((sum, s) => sum + s.profit, 0);

    const monthProfit = sales
      .filter(s => s.date >= monthStart)
      .reduce((sum, s) => sum + s.profit, 0);

    const summary = await this.db.getSummary();

    return {
      success: true,
      message: `💰 الأرباح\n\nاليوم: ${todayProfit.toFixed(2)} ج.م\nالشهر: ${monthProfit.toFixed(2)} ج.م\nالإجمالي: ${summary.total_profit.toFixed(2)} ج.م\n\n💵 الرصيد النقدي: ${summary.cash.toFixed(2)} ج.م`
    };
  }
}

// ========================================
// Command Parser
// ========================================
function parseCommand(text) {
  const parts = text.trim().split('|').map(p => p.trim());
  const cmd = parts[0].toLowerCase();

  switch(cmd) {
    case 'sell':
      if (parts.length !== 4) return { error: 'صيغة خاطئة: sell | منتج | كمية | سعر' };
      return { type: 'sell', item: parts[1], qty: parts[2], price: parts[3] };
    
    case 'buy':
      if (parts.length !== 4) return { error: 'صيغة خاطئة: buy | منتج | كمية | سعر' };
      return { type: 'buy', item: parts[1], qty: parts[2], price: parts[3] };
    
    case 'expense':
      if (parts.length !== 3) return { error: 'صيغة خاطئة: expense | عنوان | مبلغ' };
      return { type: 'expense', title: parts[1], amount: parts[2] };
    
    case 'stock':
      return { type: 'stock', item: parts[1] || null };
    
    case 'profit':
      return { type: 'profit' };
    
    case 'help':
    case 'مساعدة':
      return { type: 'help' };
    
    default:
      return { error: 'أمر غير معروف. استخدم: sell, buy, expense, stock, profit' };
  }
}

// ========================================
// WhatsApp Webhook Handler
// ========================================
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const incomingMsg = req.body.Body;
    const from = req.body.From;

    console.log(`📱 Message from ${from}: ${incomingMsg}`);

    const parsed = parseCommand(incomingMsg);
    let response;

    if (parsed.error) {
      response = parsed.error;
    } else if (parsed.type === 'help') {
      response = '📋 الأوامر المتاحة:\n\n• sell | منتج | كمية | سعر\n• buy | منتج | كمية | سعر\n• expense | عنوان | مبلغ\n• stock | منتج\n• profit\n\nمثال:\nsell | تيشرت | 5 | 80';
    } else {
      try {
        let result;
        switch(parsed.type) {
          case 'sell':
            result = await engine.sell(parsed.item, parsed.qty, parsed.price);
            break;
          case 'buy':
            result = await engine.buy(parsed.item, parsed.qty, parsed.price);
            break;
          case 'expense':
            result = await engine.expense(parsed.title, parsed.amount);
            break;
          case 'stock':
            result = await engine.stock(parsed.item);
            break;
          case 'profit':
            result = await engine.profit();
            break;
        }
        response = result.message;
        console.log(`✅ Response: ${response}`);
      } catch (error) {
        console.error('❌ Error processing command:', error);
        response = 'حدث خطأ. حاول مرة أخرى.';
      }
    }

    // Send response via Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(response);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).send('Internal Server Error');
  }
});

// ========================================
// REST API Endpoints
// ========================================

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// GET summary
app.get('/api/summary', async (req, res) => {
  try {
    const summary = await db.getSummary();
    res.json(summary);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET inventory
app.get('/api/inventory', async (req, res) => {
  try {
    const items = await db.getAllInventory();
    res.json(items);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST sell
app.post('/api/sell', async (req, res) => {
  try {
    const { item, qty, price } = req.body;
    const result = await engine.sell(item, qty, price);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST buy
app.post('/api/buy', async (req, res) => {
  try {
    const { item, qty, price } = req.body;
    const result = await engine.buy(item, qty, price);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST expense
app.post('/api/expense', async (req, res) => {
  try {
    const { title, amount } = req.body;
    const result = await engine.expense(title, amount);
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET profit
app.get('/api/profit', async (req, res) => {
  try {
    const result = await engine.profit();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ========================================
// Initialize and Start Server
// ========================================
const db = new SheetsDB();
const engine = new AccountingEngine(db);

(async () => {
  try {
    console.log('🚀 Starting server...');
    console.log('📊 Initializing database connection...');
    
    await db.init();
    
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
      console.log(`📱 WhatsApp webhook: http://localhost:${PORT}/webhook/whatsapp`);
      console.log(`🔗 Health check: http://localhost:${PORT}/health`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
})();

