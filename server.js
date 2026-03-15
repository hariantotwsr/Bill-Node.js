const http = require('http');
const sqlite3 = require('sqlite3').verbose();
const RadiusMonitor = require('radius-monitor');

// --- Baileys Imports ---
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@adiwajshing/baileys');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const fs = require('fs/promises'); // For async file operations
const qrcode = require('qrcode');
// --- End Baileys Imports ---

// --- Cron and Date Imports ---
const cron = require('node-cron');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);
// Set default timezone for dayjs operations
dayjs.tz.setDefault('Asia/Jakarta'); // Or your desired timezone
// --- End Cron and Date Imports ---

// --- Mikrotik Imports ---
const { Mikrotik } = require('mikrotik-node-api');
// --- End Mikrotik Imports ---

const PORT = process.env.PORT || 3000;

// --- Baileys Global State ---
let sock = null;
let waQrCodeData = null; // Stores base64 QR code or null
let waConnectionStatus = 'disconnected'; // 'connecting', 'open', 'close', 'qr', 'disconnected'
const WA_SESSION_PATH = process.env.WA_SESSION_PATH || './baileys_auth_info'; // Directory to store session data
// --- End Baileys Global State ---

// --- Mikrotik Global Configuration ---
const MIKROTIK_HOST = process.env.MIKROTIK_HOST || '192.168.88.1';
const MIKROTIK_USERNAME = process.env.MIKROTIK_USERNAME || 'admin';
const MIKROTIK_PASSWORD = process.env.MIKROTIK_PASSWORD || '';
const MIKROTIK_ISOLIR_PROFILE = process.env.MIKROTIK_ISOLIR_PROFILE || 'isolir';
let mikrotik = null; // Mikrotik API client instance
// --- End Mikrotik Global Configuration ---

// --- Billing Configuration ---
const DEFAULT_INVOICE_AMOUNT = parseFloat(process.env.DEFAULT_INVOICE_AMOUNT || '100000'); // Default invoice amount
// --- End Billing Configuration ---

// Initialize SQLite Database
const db = new sqlite3.Database('mydb.sqlite', (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to the SQLite database.');

    // Original users table
    db.run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    )`, (err) => {
      if (err) {
        console.error('Error creating users table', err.message);
      } else {
        db.run(`INSERT OR IGNORE INTO users (name) VALUES ('Alice'), ('Bob'), ('Charlie')`, (err) => {
          if (err) console.error('Error inserting dummy users', err.message);
          else console.log('Dummy users inserted or already exist (original).');
        });
      }
    });

    // New customers table for ISP billing
    db.run(`CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      whatsapp_number TEXT NOT NULL UNIQUE,
      mikrotik_username TEXT NOT NULL UNIQUE,
      mikrotik_profile_active TEXT NOT NULL,
      mikrotik_profile_current TEXT NOT NULL,
      billing_day_of_month INTEGER NOT NULL,
      next_invoice_due_date TEXT, -- YYYY-MM-DD for the next invoice generation target
      status TEXT NOT NULL DEFAULT 'active' -- 'active', 'isolated', 'suspended'
    )`, (err) => {
      if (err) {
        console.error('Error creating customers table', err.message);
      } else {
        console.log('Customers table created or already exists.');
        // Insert some dummy customers
        const today = dayjs().tz();
        const nextMonth = today.add(1, 'month');
        const nextInvoiceDueDate = nextMonth.date(15).format('YYYY-MM-DD'); // Assume due on 15th of next month

        db.run(`INSERT OR IGNORE INTO customers (name, whatsapp_number, mikrotik_username, mikrotik_profile_active, mikrotik_profile_current, billing_day_of_month, next_invoice_due_date, status) VALUES
          ('Customer A', '6281211112222', 'customerA', 'paket_20mbps', 'paket_20mbps', 15, '${nextInvoiceDueDate}', 'active'),
          ('Customer B', '6281233334444', 'customerB', 'paket_50mbps', 'paket_50mbps', 20, '${nextInvoiceDueDate}', 'active')`,
          (err) => {
            if (err) console.error('Error inserting dummy customers:', err.message);
            else console.log('Dummy customers inserted or already exist.');
          }
        );
      }
    });

    // New invoices table
    db.run(`CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      invoice_number TEXT NOT NULL UNIQUE,
      amount REAL NOT NULL,
      issue_date TEXT NOT NULL, -- YYYY-MM-DD
      due_date TEXT NOT NULL, -- YYYY-MM-DD
      paid_date TEXT, -- YYYY-MM-DD
      status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'paid', 'overdue', 'cancelled'
      reminder_sent_h7 INTEGER NOT NULL DEFAULT 0, -- 0 for false, 1 for true
      FOREIGN KEY (customer_id) REFERENCES customers(id)
    )`, (err) => {
      if (err) {
        console.error('Error creating invoices table', err.message);
      } else {
        console.log('Invoices table created or already exists.');
      }
    });
  }
});

// Initialize RadiusMonitor (use your actual RADIUS server details here)
const radiusMonitor = new RadiusMonitor({
  host: process.env.RADIUS_HOST || '127.0.0.1', // Replace with your RADIUS server IP
  port: parseInt(process.env.RADIUS_PORT || '1812', 10), // Replace with your RADIUS server port
  secret: process.env.RADIUS_SECRET || 'testing123', // Replace with your RADIUS shared secret
  timeout: parseInt(process.env.RADIUS_TIMEOUT || '5000', 10) // Timeout in ms
});

// --- Baileys Initialization Function ---
async function startWA() {
  console.log(`Starting WhatsApp client. Session path: ${WA_SESSION_PATH}`);

  const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_PATH); // Baileys handles directory creation if needed

  sock = makeWASocket({
    logger: pino({ level: 'silent' }), // Set to 'debug' for more verbose logging
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'), // Simulate a browser
    auth: state,
    getMessage: async (key) => {
      // This is a placeholder. In a real app, you might fetch from a message store.
      // For a simple gateway, it might not be strictly necessary to implement fully
      return { conversation: 'Hello' };
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Store QR code data to be served via API
      qrcode.toDataURL(qr, (err, url) => {
        if (err) console.error('Error generating QR code:', err);
        waQrCodeData = url; // Base64 image URL
        waConnectionStatus = 'qr';
        console.log('New QR code generated. Scan it to connect.');
      });
    }

    if (connection === 'close') {
      let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.badAuth) {
        console.log(`Bad Auth, please delete session files in ${WA_SESSION_PATH} and restart to scan again`);
        waConnectionStatus = 'disconnected';
        waQrCodeData = null; // Clear QR data
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(`Device Logged Out, please delete session files in ${WA_SESSION_PATH} and restart to scan again.`);
        waConnectionStatus = 'disconnected';
        waQrCodeData = null; // Clear QR data
      } else if (reason === DisconnectReason.connectionClosed ||
                 reason === DisconnectReason.connectionLost ||
                 reason === DisconnectReason.restartRequired ||
                 reason === DisconnectReason.timedOut) {
        console.log(`Connection closed or lost (${reason}), attempting to reconnect...`);
        waConnectionStatus = 'connecting';
        startWA(); // Attempt to reconnect
      } else {
        waConnectionStatus = 'disconnected';
        waQrCodeData = null;
        console.log(`Connection closed unexpectedly. Reason: ${reason}.`);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection opened!');
      waConnectionStatus = 'open';
      waQrCodeData = null; // Clear QR code once connected
    } else {
      waConnectionStatus = connection; // 'connecting', etc.
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // You can also listen for messages here if needed for inbound messages
  // sock.ev.on('messages.upsert', async ({ messages, type }) => {
  //   console.log('Received messages:', messages[0]);
  // });
timeout: parseInt(process.env.RADIUS_TIMEOUT || '5000', 10) // Timeout in ms
});

// --- Baileys Initialization Function ---
async function startWA() {
  console.log(`Starting WhatsApp client. Session path: ${WA_SESSION_PATH}`);

  const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_PATH); // Baileys handles directory creation if needed

  sock = makeWASocket({
    logger: pino({ level: 'silent' }), // Set to 'debug' for more verbose logging
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'), // Simulate a browser
    auth: state,
    getMessage: async (key) => {
      // This is a placeholder. In a real app, you might fetch from a message store.
      // For a simple gateway, it might not be strictly necessary to implement fully
      return { conversation: 'Hello' };
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      // Store QR code data to be served via API
      qrcode.toDataURL(qr, (err, url) => {
        if (err) console.error('Error generating QR code:', err);
        waQrCodeData = url; // Base64 image URL
        waConnectionStatus = 'qr';
        console.log('New QR code generated. Scan it to connect.');
      });
    }

    if (connection === 'close') {
      let reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (reason === DisconnectReason.badAuth) {
        console.log(`Bad Auth, please delete session files in ${WA_SESSION_PATH} and restart to scan again`);
        waConnectionStatus = 'disconnected';
        waQrCodeData = null; // Clear QR data
      } else if (reason === DisconnectReason.loggedOut) {
        console.log(`Device Logged Out, please delete session files in ${WA_SESSION_PATH} and restart to scan again.`);
        waConnectionStatus = 'disconnected';
        waQrCodeData = null; // Clear QR data
      } else if (reason === DisconnectReason.connectionClosed ||
                 reason === DisconnectReason.connectionLost ||
                 reason === DisconnectReason.restartRequired ||
                 reason === DisconnectReason.timedOut) {
        console.log(`Connection closed or lost (${reason}), attempting to reconnect...`);
        waConnectionStatus = 'connecting';
        startWA(); // Attempt to reconnect
      } else {
        waConnectionStatus = 'disconnected';
        waQrCodeData = null;
        console.log(`Connection closed unexpectedly. Reason: ${reason}.`);
      }
    } else if (connection === 'open') {
      console.log('WhatsApp connection opened!');
      waConnectionStatus = 'open';
      waQrCodeData = null; // Clear QR code once connected
    } else {
      waConnectionStatus = connection; // 'connecting', etc.
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // You can also listen for messages here if needed for inbound messages
  // sock.ev.on('messages.upsert', async ({ messages, type }) => {
  //   console.log('Received messages:', messages[0]);
  // });
}
// --- End Baileys Initialization Function ---

// --- Helper function to send WhatsApp message ---
async function sendWhatsAppMessage(to, message) {
  if (waConnectionStatus !== 'open' || !sock) {
    console.warn(`WhatsApp not connected, cannot send message to ${to}. Status: ${waConnectionStatus}`);
    throw new Error('WhatsApp client not connected or ready.');
  }

  // Ensure 'to' number is in JID format
  const recipientJid = to.endsWith('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;

  try {
    const [result] = await sock.onWhatsApp(recipientJid);
    if (result?.exists) {
      await sock.sendMessage(result.jid, { text: message });
      console.log(`WhatsApp message sent to ${to}: "${message}"`);
      return true;
    } else {
      console.warn(`Recipient ${to} is not on WhatsApp or invalid number.`);
      return false;
    }
  } catch (error) {
    console.error(`Error sending WhatsApp message to ${to}:`, error);
    throw error;
  }
}
// --- End Helper function to send WhatsApp message ---

// --- Helper function for Mikrotik API ---
async function changeMikrotikProfile(username, newProfile) {
  if (!mikrotik) {
    mikrotik = new Mikrotik({
      host: MIKROTIK_HOST,
      username: MIKROTIK_USERNAME,
      password: MIKROTIK_PASSWORD,
      port: 8728, // Default Mikrotik API port
      timeout: 5 // seconds
    });
  }

  try {
    await mikrotik.connect();
    const response = await mikrotik.write('/ppp/secret/print', ['?name=' + username]);

    if (response.length > 0) {
      const id = response[0]['.id'];
      await mikrotik.write('/ppp/secret/set', ['=.id=' + id, '=profile=' + newProfile]);
      console.log(`Mikrotik: Changed profile for user ${username} to ${newProfile}`);
      return true;
    } else {
      console.warn(`Mikrotik: User ${username} not found in PPP secrets.`);
      return false;
    }
  } catch (error) {
    console.error(`Error changing Mikrotik profile for ${username}:`, error.message);
    throw error;
  } finally {
    if (mikrotik.connected) {
      mikrotik.close();
    }
  }
}
// --- End Helper function for Mikrotik API ---

const server = http.createServer((req, res) => {
  // Helper to send JSON responses
  const sendJsonResponse = (statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  if (req.url === '/api/hello') {
    sendJsonResponse(200, { message: 'Hello from Node.js!' });
    return;
  }

  // API endpoint for general users (original table)
  if (req.url === '/api/users') {
    db.all('SELECT id, name FROM users', [], (err, rows) => {
      if (err) {
        sendJsonResponse(500, { error: err.message });
      } else {
        sendJsonResponse(200, { users: rows });
      }
    });
    return;
  }

  // API endpoint for ISP customers
  if (req.url === '/api/customers') {
    db.all('SELECT id, name, whatsapp_number, mikrotik_username, mikrotik_profile_active, mikrotik_profile_current, billing_day_of_month, next_invoice_due_date, status FROM customers', [], (err, rows) => {
      if (err) {
        sendJsonResponse(500, { error: err.message });
      } else {
        sendJsonResponse(200, { customers: rows });
      }
    });
    return;
  }

  // API endpoint for invoices
  if (req.url === '/api/invoices') {
    db.all('SELECT i.*, c.name as customer_name FROM invoices i JOIN customers c ON i.customer_id = c.id ORDER BY i.due_date DESC', [], (err, rows) => {
      if (err) {
        sendJsonResponse(500, { error: err.message });
      } else {
        sendJsonResponse(200, { invoices: rows });
      }
    });
    return;
  }

  // API endpoint to mark invoice as paid
  if (req.url.startsWith('/api/invoices/pay/') && req.method === 'POST') {
    const invoiceId = req.url.split('/').pop();
    if (!invoiceId) {
      return sendJsonResponse(400, { error: 'Invoice ID is required.' });
    }

    db.get('SELECT * FROM invoices WHERE id = ?', [invoiceId], async (err, invoice) => {
      if (err) {
        return sendJsonResponse(500, { error: err.message });
      }
      if (!invoice) {
        return sendJsonResponse(404, { error: 'Invoice not found.' });
      }
      if (invoice.status === 'paid') {
        return sendJsonResponse(400, { error: 'Invoice already paid.' });
      }

      db.run('UPDATE invoices SET status = ?, paid_date = ? WHERE id = ?', ['paid', dayjs().tz().format('YYYY-MM-DD'), invoiceId], (err) => {
        if (err) {
          return sendJsonResponse(500, { error: err.message });
        }
        sendJsonResponse(200, { success: true, message: 'Invoice marked as paid.' });
        console.log(`Invoice ${invoice.invoice_number} marked as paid.`);

        // Also check if customer was isolated and reactivate
        db.get('SELECT * FROM customers WHERE id = ?', [invoice.customer_id], async (err, customer) => {
          if (err) {
            console.error('Error fetching customer after invoice paid:', err.message);
            return;
          }
          if (customer && customer.mikrotik_profile_current === MIKROTIK_ISOLIR_PROFILE) {
            try {
              await changeMikrotikProfile(customer.mikrotik_username, customer.mikrotik_profile_active);
              db.run('UPDATE customers SET mikrotik_profile_current = ?, status = ? WHERE id = ?',
                [customer.mikrotik_profile_active, 'active', customer.id],
                (err) => {
                  if (err) console.error('Error updating customer status after reactivation:', err.message);
                }
              );
              sendWhatsAppMessage(customer.whatsapp_number, `Halo ${customer.name}, pembayaran invoice ${invoice.invoice_number} Anda telah kami terima. Layanan Anda sudah aktif kembali!`);
            } catch (mikrotikError) {
              console.error(`Failed to reactivate Mikrotik for ${customer.mikrotik_username}:`, mikrotikError.message);
            }
          }
        });
      });
    });
    return;
  }

  if (req.url === '/api/radius-info') {
    // This endpoint demonstrates radius-monitor setup.
    // To perform an actual check, you would call `radiusMonitor.check(...)`
    // Ensure you have a RADIUS server running at the configured host/port/secret
    // for actual monitoring.
    sendJsonResponse(200, {
      message: 'RadiusMonitor is initialized. Configure RADIUS_HOST, RADIUS_PORT, RADIUS_SECRET environment variables for real checks.',
      config: {
        host: radiusMonitor.host,
        port: radiusMonitor.port,
        secret: radiusMonitor.secret ? '********' : null, // Mask secret for security
        timeout: radiusMonitor.timeout
      },
      howToUse: "Call /api/radius-check endpoint to check your RADIUS server status."
    });
    return;
  }

  if (req.url === '/api/radius-check') {
    radiusMonitor.check((err, status) => {
      if (err) {
        console.error('RADIUS check error:', err.message);
        sendJsonResponse(500, { status: 'unreachable', error: err.message });
      } else {
        console.log('RADIUS check status:', status);
        // 'status' from radius-monitor is typically true/false or an object.
        // We'll simplify to 'reachable' if no error.
        sendJsonResponse(200, { status: 'reachable' });
      }
    });
    return;
  }

  // New endpoint for total user count (original users)
  if (req.url === '/api/users/count') {
    db.get('SELECT COUNT(*) AS total FROM users', [], (err, row) => {
      if (err) {
        sendJsonResponse(500, { error: err.message });
      } else {
        sendJsonResponse(200, { totalUsers: row.total });
      }
    });
    return;
  }

  // New endpoint for total ISP customers count
  if (req.url === '/api/customers/count') {
    db.get('SELECT COUNT(*) AS total FROM customers', [], (err, row) => {
      if (err) {
        sendJsonResponse(500, { error: err.message });
      } else {
        sendJsonResponse(200, { totalCustomers: row.total });
      }
    });
    return;
  }

  // New endpoint for pending invoices count
  if (req.url === '/api/invoices/pending/count') {
    db.get("SELECT COUNT(*) AS total FROM invoices WHERE status = 'pending'", [], (err, row) => {
      if (err) {
        sendJsonResponse(500, { error: err.message });
      } else {
        sendJsonResponse(200, { totalPendingInvoices: row.total });
      }
    });
    return;
  }

  // --- New WhatsApp API Endpoints ---
  if (req.url === '/api/whatsapp/status') {
    sendJsonResponse(200, {
      status: waConnectionStatus,
      qrCode: waQrCodeData // Will be null if not in 'qr' state or already connected
    });
    return;
  }

  if (req.url === '/api/whatsapp/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { to, message } = JSON.parse(body);
        if (!to || !message) {
          return sendJsonResponse(400, { error: 'Both "to" and "message" are required.' });
        }
        if (waConnectionStatus !== 'open' || !sock) {
          return sendJsonResponse(400, { error: 'WhatsApp not connected.' });
        }

        // Convert number to JID format if not already
        const recipientJid = to.endsWith('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        
        const [result] = await sock.onWhatsApp(recipientJid);
        if (result?.exists) {
          await sock.sendMessage(result.jid, { text: message });
          sendJsonResponse(200, { success: true, message: 'Message sent.' });
        } else {
          sendJsonResponse(404, { error: 'Recipient is not on WhatsApp or invalid number.' });
        }
      } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        sendJsonResponse(500, { error: error.message || 'Failed to send message.' });
      }
    });
    return;
return;
  }

  // --- New WhatsApp API Endpoints ---
  if (req.url === '/api/whatsapp/status') {
    sendJsonResponse(200, {
      status: waConnectionStatus,
      qrCode: waQrCodeData // Will be null if not in 'qr' state or already connected
    });
    return;
  }

  if (req.url === '/api/whatsapp/send' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      try {
        const { to, message } = JSON.parse(body);
        if (!to || !message) {
          return sendJsonResponse(400, { error: 'Both "to" and "message" are required.' });
        }
        if (waConnectionStatus !== 'open' || !sock) {
          return sendJsonResponse(400, { error: 'WhatsApp not connected.' });
        }

        // Convert number to JID format if not already
        const recipientJid = to.endsWith('@s.whatsapp.net') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
        
        const [result] = await sock.onWhatsApp(recipientJid);
        if (result?.exists) {
          await sock.sendMessage(result.jid, { text: message });
          sendJsonResponse(200, { success: true, message: 'Message sent.' });
        } else {
          sendJsonResponse(404, { error: 'Recipient is not on WhatsApp or invalid number.' });
        }
      } catch (error) {
        console.error('Error sending WhatsApp message:', error);
        sendJsonResponse(500, { error: error.message || 'Failed to send message.' });
      }
    });
    return;
  }
  // --- End New WhatsApp API Endpoints ---

  // Main Dashboard
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Dashboard Billing ISP</title>
        <style>
          body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Open Sans", "Helvetica Neue", sans-serif; background: #1a1a1a; color: #eee; margin: 0; padding: 20px; line-height: 1.6; }
          .container { max-width: 1100px; margin: 0 auto; background: #2a2a2a; padding: 20px; border-radius: 8px; box-shadow: 0 4px 8px rgba(0,0,0,0.3); }
          h1 { text-align: center; color: #68A063; margin-bottom: 20px; }
          h2 { color: #88c0d0; margin-top: 30px; border-bottom: 1px solid #444; padding-bottom: 5px; }
          h3 { color: #88c0d0; margin-top: 15px; }

          /* Dashboard Overview */
          .dashboard-overview { display: flex; justify-content: space-around; gap: 20px; margin-bottom: 30px; }
          .card { background: #3a3a3a; padding: 20px; border-radius: 8px; flex: 1; text-align: center; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }
          .card h3 { margin-top: 0; color: #68A063; }
          .card p { font-size: 1.5em; font-weight: bold; margin: 5px 0 0; }

          /* Main Grid for sections */
          .dashboard-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 20px; margin-bottom: 30px; }
          .api-section { padding: 15px; background: #3a3a3a; border-radius: 5px; box-shadow: 0 2px 4px rgba(0,0,0,0.2); }

          ul { list-style-type: none; padding: 0; }
          li { margin-bottom: 5px; }
          pre { background: #1a1a1a; padding: 10px; border-radius: 4px; overflow-x: auto; font-size: 0.9em; }
          .status-indicator { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background-color: grey; margin-right: 8px; }
          .status-indicator.green { background-color: #68A063; }
          .status-indicator.red { background-color: #e06c75; }
          .status-indicator.yellow { background-color: #d1b000; } /* For pending state */

          .primary-button { background-color: #68A063; color: white; border: none; padding: 10px 18px; border-radius: 5px; cursor: pointer; margin-top: 15px; font-size: 0.9em; transition: background-color 0.2s ease; }
          .primary-button:hover { background-color: #5a9053; }
          .button-link { display: inline-block; background-color: #88c0d0; color: #1a1a1a; padding: 8px 15px; border-radius: 5px; text-decoration: none; margin-top: 10px; font-size: 0.85em; transition: background-color 0.2s ease; }
          .button-link:hover { background-color: #70a7b9; }

          .error-text { color: #e06c75; font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>Dashboard Billing ISP</h1>
          <p style="text-align:center; color: #aaa;">Server berjalan di port ${PORT}</p>

          <div class="dashboard-overview">
            <div class="card">
              <h3>Total Pelanggan ISP</h3>
              <p id="totalCustomersCount">Memuat...</p>
            </div>
            <div class="card">
              <h3>Faktur Tertunda</h3>
              <p id="totalPendingInvoices">Memuat...</p>
            </div>
            <div class="card">
              <h3>Pelanggan Terisolasi</h3>
              <p id="isolatedCustomersCount">Memuat...</p>
            </div>
          </div>

          <div class="dashboard-grid">
            <div class="api-section">
              <h2>Manajemen Pelanggan</h2>
              <ul id="customersList">
                <li>Memuat pelanggan...</li>
              </ul>
              <a href="/api/customers" target="_blank" class="button-link">Lihat Semua Pelanggan (JSON)</a>
            </div>

            <div class="api-section">
              <h2>Status Jaringan & RADIUS</h2>
              <div id="radiusInfo">
                <p>Memuat info RADIUS...</p>
              </div>
              <div style="margin-top: 15px;">
                <p id="radiusCheckResult" style="margin-top: 10px; font-weight: bold;">Memeriksa status RADIUS...</p>
                <button id="checkRadiusStatusBtn" class="primary-button">Periksa Ulang Status RADIUS</button>
              </div>
              <p style="font-size: 0.8em; color: #aaa; margin-top: 10px;">
                (Untuk RadiusMonitor, konfigurasikan variabel lingkungan RADIUS_HOST, RADIUS_PORT, RADIUS_SECRET.)
              </p>
            </div>

            <div class="api-section">
              <h2>Billing & Pembayaran</h2>
              <p>Daftar faktur terbaru:</p>
              <ul id="invoicesList">
                <li>Memuat faktur...</li>
              </ul>
              <a href="/api/invoices" target="_blank" class="button-link">Lihat Semua Faktur (JSON)</a>
              <p style="font-size: 0.8em; color: #aaa; margin-top: 10px;">
                (Cron jobs otomatis berjalan di latar belakang untuk membuat faktur, mengirim pengingat, dan mengelola isolasi.)
              </p>
            </div>

            <div class="api-section">
              <h2>Layanan & Paket</h2>
              <p>Manajemen layanan dan paket internet.</p>
              <ul>
                <li><a href="#" class="button-link">Daftar Paket</a></li>
                <li><a href="#" class="button-link">Tambah Paket Baru</a></li>
              </ul>
            </div>
          </div>

          <!-- New WhatsApp Gateway Section -->
          <div class="api-section">
            <h2>WhatsApp Gateway</h2>
            <div id="waStatusInfo" style="margin-bottom: 10px;">
              <p style="font-weight: bold;"><span id="waConnectionIndicator" class="status-indicator yellow"></span>Status: <span id="waConnectionText">Memuat...</span></p>
            </div>
            <div id="waQrCodeContainer" style="text-align: center; margin-bottom: 15px; display: none;">
              <p style="margin-bottom: 5px;">Pindai QR ini untuk login:</p>
              <img id="waQrCodeImage" src="" alt="WhatsApp QR Code" style="width: 250px; height: 250px; border: 1px solid #444; border-radius: 5px; background-color: white; padding: 10px;">
              <p style="font-size: 0.8em; color: #aaa; margin-top: 10px;">(QR akan kadaluarsa setelah beberapa saat)</p>
            </div>
            <div id="waSendMessage" style="margin-top: 20px;">
              <h3>Kirim Pesan Uji Coba</h3>
              <input type="text" id="waRecipientNumber" placeholder="Nomor Telepon (mis: 6281234567890)" style="width: calc(100% - 22px); padding: 10px; margin-bottom: 10px; border-radius: 5px; border: 1px solid #444; background: #1a1a1a; color: #eee;">
              <textarea id="waMessageContent" placeholder="Isi Pesan" rows="3" style="width: calc(100% - 22px); padding: 10px; margin-bottom: 10px; border-radius: 5px; border: 1px solid #444; background: #1a1a1a; color: #eee;"></textarea>
              <button id="sendWAMessageBtn" class="primary-button">Kirim Pesan WhatsApp</button>
              <p id="waSendMessageResult" style="margin-top: 10px; font-weight: bold;"></p>
            </div>
            <p style="font-size: 0.8em; color: #aaa; margin-top: 10px;">
              (Sesi WhatsApp disimpan di folder './baileys_auth_info'. Hapus folder tersebut jika ingin login ulang.)
</ul>
            </div>

            <div class="api-section">
              <h2>Layanan & Paket</h2>
              <p>Manajemen layanan dan paket internet.</p>
              <ul>
                <li><a href="#" class="button-link">Daftar Paket</a></li>
                <li><a href="#" class="button-link">Tambah Paket Baru</a></li>
              </ul>
            </div>
          </div>

          <!-- New WhatsApp Gateway Section -->
          <div class="api-section">
            <h2>WhatsApp Gateway</h2>
            <div id="waStatusInfo" style="margin-bottom: 10px;">
              <p style="font-weight: bold;"><span id="waConnectionIndicator" class="status-indicator yellow"></span>Status: <span id="waConnectionText">Memuat...</span></p>
            </div>
            <div id="waQrCodeContainer" style="text-align: center; margin-bottom: 15px; display: none;">
              <p style="margin-bottom: 5px;">Pindai QR ini untuk login:</p>
              <img id="waQrCodeImage" src="" alt="WhatsApp QR Code" style="width: 250px; height: 250px; border: 1px solid #444; border-radius: 5px; background-color: white; padding: 10px;">
              <p style="font-size: 0.8em; color: #aaa; margin-top: 10px;">(QR akan kadaluarsa setelah beberapa saat)</p>
            </div>
            <div id="waSendMessage" style="margin-top: 20px;">
              <h3>Kirim Pesan Uji Coba</h3>
              <input type="text" id="waRecipientNumber" placeholder="Nomor Telepon (mis: 6281234567890)" style="width: calc(100% - 22px); padding: 10px; margin-bottom: 10px; border-radius: 5px; border: 1px solid #444; background: #1a1a1a; color: #eee;">
              <textarea id="waMessageContent" placeholder="Isi Pesan" rows="3" style="width: calc(100% - 22px); padding: 10px; margin-bottom: 10px; border-radius: 5px; border: 1px solid #444; background: #1a1a1a; color: #eee;"></textarea>
              <button id="sendWAMessageBtn" class="primary-button">Kirim Pesan WhatsApp</button>
              <p id="waSendMessageResult" style="margin-top: 10px; font-weight: bold;"></p>
            </div>
            <p style="font-size: 0.8em; color: #aaa; margin-top: 10px;">
              (Sesi WhatsApp disimpan di folder './baileys_auth_info'. Hapus folder tersebut jika ingin login ulang.)
            </p>
          </div>
          <!-- End New WhatsApp Gateway Section -->

          <div class="api-section">
            <h2>Mikrotik Status</h2>
            <p>Konfigurasi Mikrotik yang digunakan untuk isolasi/aktivasi:</p>
            <pre>
Host: ${MIKROTIK_HOST}
Username: ${MIKROTIK_USERNAME}
Profile Isolir: ${MIKROTIK_ISOLIR_PROFILE}
            </pre>
            <p style="font-size: 0.8em; color: #aaa; margin-top: 10px;">
              (Pastikan variabel lingkungan MIKROTIK_HOST, MIKROTIK_USERNAME, MIKROTIK_PASSWORD, MIKROTIK_ISOLIR_PROFILE telah diatur.)
            </p>
          </div>

          <div class="api-section">
            <h2>API Info Umum</h2>
            <p id="helloMessage">Memuat pesan hello...</p>
            <a href="/api/hello" target="_blank" class="button-link">Coba /api/hello</a>
          </div>
        </div>

        <script>
          async function checkRadiusStatus(initialLoad = false) {
            const resultElement = document.getElementById('radiusCheckResult');
            if (initialLoad) {
                resultElement.innerHTML = '<span class="status-indicator yellow"></span>Memeriksa server RADIUS...';
                resultElement.style.color = 'yellow';
            } else {
                resultElement.innerHTML = '<span class="status-indicator yellow"></span>Memeriksa ulang server RADIUS...';
                resultElement.style.color = 'yellow'; // Indicate pending
            }


            try {
              const checkRes = await fetch('/api/radius-check');
              const checkData = await checkRes.json();
              if (checkData.status === 'reachable') {
                resultElement.innerHTML = '<span class="status-indicator green"></span>RADIUS Server dapat dijangkau!';
                resultElement.style.color = '#68A063';
              } else {
                resultElement.innerHTML = \`<span class="status-indicator red"></span>RADIUS Server TIDAK dapat dijangkau: \${checkData.error || 'Unknown error'}\`;
                resultElement.style.color = '#e06c75';
              }
            } catch (error) {
              resultElement.innerHTML = '<span class="status-indicator red"></span>Error memeriksa RADIUS: ' + error.message;
              resultElement.style.color = '#e06c75';
            }
          }

          // --- WhatsApp Gateway Functions ---
          async function updateWhatsAppStatus() {
              const waStatusIndicator = document.getElementById('waConnectionIndicator');
              const waConnectionText = document.getElementById('waConnectionText');
              const waQrCodeContainer = document.getElementById('waQrCodeContainer');
              const waQrCodeImage = document.getElementById('waQrCodeImage');

              try {
                  const waRes = await fetch('/api/whatsapp/status');
                  const waData = await waRes.json();

                  waQrCodeContainer.style.display = 'none'; // Hide by default

                  // Set indicator color and text based on status
                  waStatusIndicator.className = 'status-indicator'; // Reset
                  if (waData.status === 'open') {
                      waStatusIndicator.classList.add('green');
                      waConnectionText.textContent = 'TERHUBUNG';
                  } else if (waData.status === 'qr') {
                      waStatusIndicator.classList.add('yellow');
                      waConnectionText.textContent = 'QR Code Siap (Pindai)';
                      if (waData.qrCode) {
                          waQrCodeImage.src = waData.qrCode;
                          waQrCodeContainer.style.display = 'block'; // Show QR if available
                      }
                  } else if (waData.status === 'connecting') {
                      waStatusIndicator.classList.add('yellow');
                      waConnectionText.textContent = 'MENGHUBUNGKAN...';
                  } else { // 'disconnected', 'close', etc.
                      waStatusIndicator.classList.add('red');
                      waConnectionText.textContent = 'TIDAK TERHUBUNG';
                  }
              } catch (error) {
                  waConnectionText.innerHTML = '<span class="error-text">Error!</span>';
                  waStatusIndicator.classList.add('red');
                  console.error('Error loading WhatsApp status:', error.message);
              }
          }
          // --- End WhatsApp Gateway Functions ---

          async function fetchDataAndRenderDashboard() {
            // Dashboard Overview - Total Customers
            try {
              const customersCountRes = await fetch('/api/customers/count');
              const customersCountData = await customersCountRes.json();
              document.getElementById('totalCustomersCount').textContent = customersCountData.totalCustomers;
            } catch (error) {
              document.getElementById('totalCustomersCount').innerHTML = '<span class="error-text">Error!</span>';
              console.error('Error loading total customers:', error.message);
            }

            // Dashboard Overview - Total Pending Invoices
            try {
              const pendingInvoicesRes = await fetch('/api/invoices/pending/count');
              const pendingInvoicesData = await pendingInvoicesRes.json();
              document.getElementById('totalPendingInvoices').textContent = pendingInvoicesData.totalPendingInvoices;
            } catch (error) {
              document.getElementById('totalPendingInvoices').innerHTML = '<span class="error-text">Error!</span>';
              console.error('Error loading pending invoices count:', error.message);
            }

            // Dashboard Overview - Isolated Customers Count (Placeholder for now, could add API later)
            // For now, let's estimate from customers list if we fetch it
            document.getElementById('isolatedCustomersCount').textContent = 'Memuat...';

            // Customers API (for list)
            try {
              const customersRes = await fetch('/api/customers');
              const customersData = await customersRes.json();
              const customersListElement = document.getElementById('customersList');
              customersListElement.innerHTML = ''; // Clear loading message
              let isolatedCount = 0;
              if (customersData.customers && customersData.customers.length > 0) {
                customersData.customers.forEach(customer => {
                  const li = document.createElement('li');
                  li.textContent = \`ID: \${customer.id}, Nama: \${customer.name}, MT User: \${customer.mikrotik_username}, Status: \${customer.status}\`;
                  customersListElement.appendChild(li);
                  if (customer.status === 'isolated') {
                      isolatedCount++;
                  }
                });
                document.getElementById('isolatedCustomersCount').textContent = isolatedCount;
              } else {
                customersListElement.innerHTML = '<li>Tidak ada pelanggan ditemukan.</li>';
                document.getElementById('isolatedCustomersCount').textContent = 0;
              }
            } catch (error) {
              document.getElementById('customersList').innerHTML = '<li><span class="error-text">Error loading customers: ' + error.message + '</span></li>';
              document.getElementById('isolatedCustomersCount').innerHTML = '<span class="error-text">Error!</span>';
            }

            // Invoices API (for list)
            try {
              const invoicesRes = await fetch('/api/invoices');
              const invoicesData = await invoicesRes.json();
              const invoicesListElement = document.getElementById('invoicesList');
              invoicesListElement.innerHTML = ''; // Clear loading message
              if (invoicesData.invoices && invoicesData.invoices.length > 0) {
                invoicesData.invoices.slice(0, 5).forEach(invoice => { // Show last 5 invoices
                  const li = document.createElement('li');
                  const statusColor = invoice.status === 'paid' ? 'green' : (invoice.status === 'overdue' ? 'red' : 'yellow');
                  li.innerHTML = \`#\${invoice.invoice_number} - \${invoice.customer_name} (Rp \${invoice.amount.toLocaleString('id-ID')}) - Due: \${invoice.due_date} - Status: <span style="color: \${statusColor};">\${invoice.status.toUpperCase()}</span>\`;
                  invoicesListElement.appendChild(li);
                });
              } else {
                invoicesListElement.innerHTML = '<li>Tidak ada faktur ditemukan.</li>';
              }
            } catch (error) {
              document.getElementById('invoicesList').innerHTML = '<li><span class="error-text">Error loading invoices: ' + error.message + '</span></li>';
            }

            // RADIUS Info API
            try {
              const radiusInfoRes = await fetch('/api/radius-info');
              const radiusInfoData = await radiusInfoRes.json();
              const radiusInfoElement = document.getElementById('radiusInfo');
              radiusInfoElement.innerHTML = \`
                <p>\${radiusInfoData.message}</p>
                <h3>Konfigurasi RADIUS:</h3>
                <pre>\${JSON.stringify(radiusInfoData.config, null, 2)}</pre>
              \`;
            } catch (error) {
              document.getElementById('radiusInfo').innerHTML = '<p><span class="error-text">Error loading RADIUS info: ' + error.message + '</span></p>';
            }

            // Initial RADIUS check on page load
            checkRadiusStatus(true);

            // Hello API
            try {
              const helloRes = await fetch('/api/hello');
              const helloData = await helloRes.json();
              document.getElementById('helloMessage').textContent = helloData.message;
            } catch (error) {
              document.getElementById('helloMessage').innerHTML = '<span class="error-text">Error loading hello message: ' + error.message + '</span>';
            }
          }

          // --- WhatsApp Gateway Functions ---
          async function updateWhatsAppStatus() {
              const waStatusIndicator = document.getElementById('waConnectionIndicator');
              const waConnectionText = document.getElementById('waConnectionText');
              const waQrCodeContainer = document.getElementById('waQrCodeContainer');
              const waQrCodeImage = document.getElementById('waQrCodeImage');

              try {
                  const waRes = await fetch('/api/whatsapp/status');
                  const waData = await waRes.json();

                  waQrCodeContainer.style.display = 'none'; // Hide by default

                  // Set indicator color and text based on status
                  waStatusIndicator.className = 'status-indicator'; // Reset
                  if (waData.status === 'open') {
                      waStatusIndicator.classList.add('green');
                      waConnectionText.textContent = 'TERHUBUNG';
                  } else if (waData.status === 'qr') {
                      waStatusIndicator.classList.add('yellow');
                      waConnectionText.textContent = 'QR Code Siap (Pindai)';
                      if (waData.qrCode) {
                          waQrCodeImage.src = waData.qrCode;
                          waQrCodeContainer.style.display = 'block'; // Show QR if available
                      }
                  } else if (waData.status === 'connecting') {
                      waStatusIndicator.classList.add('yellow');
                      waConnectionText.textContent = 'MENGHUBUNGKAN...';
                  } else { // 'disconnected', 'close', etc.
                      waStatusIndicator.classList.add('red');
                      waConnectionText.textContent = 'TIDAK TERHUBUNG';
                  }
              } catch (error) {
                  waConnectionText.innerHTML = '<span class="error-text">Error!</span>';
                  waStatusIndicator.classList.add('red');
                  console.error('Error loading WhatsApp status:', error.message);
              }
          }
          // --- End WhatsApp Gateway Functions ---

          async function fetchDataAndRenderDashboard() {
            // Dashboard Overview - Total Users
            try {
              const usersCountRes = await fetch('/api/users/count');
              const usersCountData = await usersCountRes.json();
              document.getElementById('totalUsersCount').textContent = usersCountData.totalUsers;
            } catch (error) {
              document.getElementById('totalUsersCount').innerHTML = '<span class="error-text">Error!</span>';
              console.error('Error loading total users:', error.message);
            }

            // Users API (for list)
            try {
              const usersRes = await fetch('/api/users');
              const usersData = await usersRes.json();
              const usersListElement = document.getElementById('usersList');
              usersListElement.innerHTML = ''; // Clear loading message
              if (usersData.users && usersData.users.length > 0) {
                usersData.users.forEach(user => {
                  const li = document.createElement('li');
                  li.textContent = \`ID: \${user.id}, Name: \${user.name}\`;
                  usersListElement.appendChild(li);
                });
              } else {
                usersListElement.innerHTML = '<li>Tidak ada pengguna ditemukan.</li>';
              }
            } catch (error) {
              document.getElementById('usersList').innerHTML = '<li><span class="error-text">Error loading users: ' + error.message + '</span></li>';
            }

            // RADIUS Info API
            try {
              const radiusInfoRes = await fetch('/api/radius-info');
              const radiusInfoData = await radiusInfoRes.json();
              const radiusInfoElement = document.getElementById('radiusInfo');
              radiusInfoElement.innerHTML = \`
                <p>\${radiusInfoData.message}</p>
                <h3>Konfigurasi RADIUS:</h3>
                <pre>\${JSON.stringify(radiusInfoData.config, null, 2)}</pre>
              \`;
            } catch (error) {
              document.getElementById('radiusInfo').innerHTML = '<p><span class="error-text">Error loading RADIUS info: ' + error.message + '</span></p>';
            }

            // Initial RADIUS check on page load
            checkRadiusStatus(true);

            // Hello API
            try {
              const helloRes = await fetch('/api/hello');
              const helloData = await helloRes.json();
              document.getElementById('helloMessage').textContent = helloData.message;
            } catch (error) {
              document.getElementById('helloMessage').innerHTML = '<span class="error-text">Error loading hello message: ' + error.message + '</span>';
            }

            // Initial WhatsApp status update and set up polling
            updateWhatsAppStatus();
            setInterval(updateWhatsAppStatus, 10000); // Poll every 10 seconds

            // WhatsApp Send Message Button Handler
            const sendWAMessageBtn = document.getElementById('sendWAMessageBtn');
            const waRecipientNumber = document.getElementById('waRecipientNumber');
            const waMessageContent = document.getElementById('waMessageContent');
            const waSendMessageResult = document.getElementById('waSendMessageResult');

            if (sendWAMessageBtn) {
                sendWAMessageBtn.addEventListener('click', async () => {
                    const to = waRecipientNumber.value.trim();
                    const message = waMessageContent.value.trim();

                    if (!to || !message) {
                        waSendMessageResult.innerHTML = '<span class="error-text">Nomor dan pesan tidak boleh kosong!</span>';
                        return;
                    }
                    if (!/^\d+$/.test(to)) {
                        waSendMessageResult.innerHTML = '<span class="error-text">Nomor telepon harus berupa angka!</span>';
                        return;
                    }

                    waSendMessageResult.innerHTML = '<span class="status-indicator yellow"></span>Mengirim pesan...';
                    waSendMessageResult.style.color = 'yellow';

                    try {
                        const sendRes = await fetch('/api/whatsapp/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ to, message })
                        });
                        const sendData = await sendRes.json();

                        if (sendData.success) {
                            waSendMessageResult.innerHTML = '<span class="status-indicator green"></span>Pesan berhasil dikirim!';
                            waSendMessageResult.style.color = '#68A063';
                            waMessageContent.value = ''; // Clear message after sending
                        } else {
                            waSendMessageResult.innerHTML = `<span class="status-indicator red"></span>Gagal mengirim: ${sendData.error || 'Unknown error'}`;
                            waSendMessageResult.style.color = '#e06c75';
                        }
                    } catch (error) {
                        waSendMessageResult.innerHTML = '<span class="status-indicator red"></span>Error mengirim pesan: ' + error.message;
                        waSendMessageResult.style.color = '#e06c75';
                    }
document.getElementById('helloMessage').innerHTML = '<span class="error-text">Error loading hello message: ' + error.message + '</span>';
            }

            // Initial WhatsApp status update and set up polling
            updateWhatsAppStatus();
            setInterval(updateWhatsAppStatus, 10000); // Poll every 10 seconds

            // WhatsApp Send Message Button Handler
            const sendWAMessageBtn = document.getElementById('sendWAMessageBtn');
            const waRecipientNumber = document.getElementById('waRecipientNumber');
            const waMessageContent = document.getElementById('waMessageContent');
            const waSendMessageResult = document.getElementById('waSendMessageResult');

            if (sendWAMessageBtn) {
                sendWAMessageBtn.addEventListener('click', async () => {
                    const to = waRecipientNumber.value.trim();
                    const message = waMessageContent.value.trim();

                    if (!to || !message) {
                        waSendMessageResult.innerHTML = '<span class="error-indicator red"></span>Nomor dan pesan tidak boleh kosong!';
                        waSendMessageResult.style.color = '#e06c75';
                        return;
                    }
                    if (!/^\d+$/.test(to)) {
                        waSendMessageResult.innerHTML = '<span class="error-indicator red"></span>Nomor telepon harus berupa angka!';
                        waSendMessageResult.style.color = '#e06c75';
                        return;
                    }

                    waSendMessageResult.innerHTML = '<span class="status-indicator yellow"></span>Mengirim pesan...';
                    waSendMessageResult.style.color = 'yellow';

                    try {
                        const sendRes = await fetch('/api/whatsapp/send', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ to, message })
                        });
                        const sendData = await sendRes.json();

                        if (sendData.success) {
                            waSendMessageResult.innerHTML = '<span class="status-indicator green"></span>Pesan berhasil dikirim!';
                            waSendMessageResult.style.color = '#68A063';
                            waMessageContent.value = ''; // Clear message after sending
                        } else {
                            waSendMessageResult.innerHTML = `<span class="status-indicator red"></span>Gagal mengirim: ${sendData.error || 'Unknown error'}`;
                            waSendMessageResult.style.color = '#e06c75';
                        }
                    } catch (error) {
                        waSendMessageResult.innerHTML = '<span class="status-indicator red"></span>Error mengirim pesan: ' + error.message;
                        waSendMessageResult.style.color = '#e06c75';
                    }
                });
            }
          }

          document.addEventListener('DOMContentLoaded', fetchDataAndRenderDashboard);

          // RADIUS check button event listener
          document.getElementById('checkRadiusStatusBtn').addEventListener('click', () => checkRadiusStatus(false));
        </script>
      </body>
    </html>
  `);
});

// --- Cron Job Implementations ---

/**
 * Task 1: Generate new invoice di h -14 duedate
 * Runs daily at 01:00 AM
 */
cron.schedule('0 1 * * *', async () => {
  console.log('--- CRON: Checking for new invoices to generate (H-14 due date) ---');
  const today = dayjs().tz();
  const targetDueDate = today.add(14, 'day'); // Invoice due in 14 days from now

  db.all('SELECT * FROM customers WHERE status = "active"', async (err, customers) => {
    if (err) {
      console.error('CRON Error fetching active customers for invoice generation:', err.message);
      return;
    }

    for (const customer of customers) {
      // Find the issue_date for the *next* invoice based on billing_day_of_month
      const billingDay = customer.billing_day_of_month;
      let nextBillingMonth = today.date(billingDay);
      // If the billing day has already passed this month, target next month
      if (nextBillingMonth.isBefore(today, 'day') || nextBillingMonth.isSame(today, 'day')) {
          nextBillingMonth = nextBillingMonth.add(1, 'month');
      }
      const invoiceDueDate = nextBillingMonth.format('YYYY-MM-DD');

      // Check if an invoice for this due date already exists
      db.get('SELECT * FROM invoices WHERE customer_id = ? AND due_date = ?', [customer.id, invoiceDueDate], async (err, existingInvoice) => {
        if (err) {
          console.error(`CRON Error checking existing invoice for customer ${customer.id}:`, err.message);
          return;
        }

        if (existingInvoice) {
          // console.log(`Invoice for customer ${customer.name} with due date ${invoiceDueDate} already exists. Skipping.`);
          return;
        }

        // Generate invoice if today is 14 days before the invoiceDueDate
        const daysUntilDue = dayjs(invoiceDueDate).diff(today, 'day');

        if (daysUntilDue === 14) { // Exactly 14 days before due date
          const invoiceNumber = `INV-${today.format('YYYYMMDD')}-${customer.id}`;
          const issueDate = today.format('YYYY-MM-DD');
          const amount = DEFAULT_INVOICE_AMOUNT;

          db.run(`INSERT INTO invoices (customer_id, invoice_number, amount, issue_date, due_date, status) VALUES (?, ?, ?, ?, ?, ?)`,
            [customer.id, invoiceNumber, amount, issueDate, invoiceDueDate, 'pending'],
            function(insertErr) {
              if (insertErr) {
                console.error(`CRON Error inserting new invoice for ${customer.name}:`, insertErr.message);
              } else {
                console.log(`CRON: Generated new invoice ${invoiceNumber} for ${customer.name}, due on ${invoiceDueDate}.`);
                sendWhatsAppMessage(customer.whatsapp_number,
                  `Halo ${customer.name}, tagihan layanan internet Anda sudah terbit. Nomor invoice: ${invoiceNumber}, Jumlah: Rp ${amount.toLocaleString('id-ID')}, Jatuh Tempo: ${invoiceDueDate}. Mohon segera lakukan pembayaran.`
                ).catch(waErr => console.error('CRON WA send error:', waErr.message));
              }
            }
          );
        }
      });
    }
  });
});

/**
 * Task 2: Send reminder WA di h-7 duedate
 * Runs daily at 09:00 AM
 */
cron.schedule('0 9 * * *', async () => {
  console.log('--- CRON: Checking for invoices to send H-7 reminder ---');
  const today = dayjs().tz().format('YYYY-MM-DD');
  const sevenDaysFromNow = dayjs().tz().add(7, 'day').format('YYYY-MM-DD');

  db.all(`SELECT i.*, c.name, c.whatsapp_number FROM invoices i JOIN customers c ON i.customer_id = c.id
          WHERE i.due_date = ? AND i.status = 'pending' AND i.reminder_sent_h7 = 0`,
    [sevenDaysFromNow], async (err, invoices) => {
      if (err) {
        console.error('CRON Error fetching invoices for H-7 reminder:', err.message);
        return;
      }

      for (const invoice of invoices) {
        try {
          await sendWhatsAppMessage(invoice.whatsapp_number,
            `[PENGINGAT] Halo ${invoice.name}, tagihan invoice ${invoice.invoice_number} sebesar Rp ${invoice.amount.toLocaleString('id-ID')} akan jatuh tempo dalam 7 hari pada ${invoice.due_date}. Mohon segera lakukan pembayaran.`
          );
          db.run('UPDATE invoices SET reminder_sent_h7 = 1 WHERE id = ?', [invoice.id], (updateErr) => {
            if (updateErr) console.error(`CRON Error updating reminder_sent_h7 for invoice ${invoice.id}:`, updateErr.message);
            else console.log(`CRON: Sent H-7 reminder for invoice ${invoice.invoice_number} to ${invoice.name}.`);
          });
        } catch (waErr) {
          console.error(`CRON Failed to send H-7 WA reminder for invoice ${invoice.invoice_number}:`, waErr.message);
        }
      }
    }
  );
});

/**
 * Task 3: Isolir ke profile "isolir" mikrotik di h+5 duedate
 * Runs daily at 10:00 AM
 */
cron.schedule('0 10 * * *', async () => {
  console.log('--- CRON: Checking for overdue invoices to apply Mikrotik isolation (H+5 due date) ---');
  const today = dayjs().tz();
  const isolationDateThreshold = today.subtract(5, 'day').format('YYYY-MM-DD'); // 5 days past due

  db.all(`SELECT i.*, c.name, c.whatsapp_number, c.mikrotik_username, c.mikrotik_profile_current FROM invoices i JOIN customers c ON i.customer_id = c.id
          WHERE i.status = 'pending' AND i.due_date <= ? AND c.mikrotik_profile_current != ?`,
    [isolationDateThreshold, MIKROTIK_ISOLIR_PROFILE], async (err, invoices) => {
      if (err) {
        console.error('CRON Error fetching overdue invoices for isolation:', err.message);
        return;
      }

      for (const invoice of invoices) {
        try {
          await changeMikrotikProfile(invoice.mikrotik_username, MIKROTIK_ISOLIR_PROFILE);
          db.run('UPDATE customers SET mikrotik_profile_current = ?, status = ? WHERE id = ?',
            [MIKROTIK_ISOLIR_PROFILE, 'isolated', invoice.customer_id],
            (updateErr) => {
              if (updateErr) console.error(`CRON Error updating customer ${invoice.customer_id} status to isolated:`, updateErr.message);
              else console.log(`CRON: Isolated Mikrotik user ${invoice.mikrotik_username} for overdue invoice ${invoice.invoice_number}.`);
            }
          );
          db.run('UPDATE invoices SET status = "overdue" WHERE id = ?', [invoice.id]); // Mark invoice as overdue
          sendWhatsAppMessage(invoice.whatsapp_number,
            `[PEMBERITAHUAN PENTING] Halo ${invoice.name}, karena invoice ${invoice.invoice_number} (Rp ${invoice.amount.toLocaleString('id-ID')}) telah lewat jatuh tempo lebih dari 5 hari, layanan internet Anda telah kami isolasi sementara. Mohon segera lunasi pembayaran untuk mengaktifkan kembali layanan Anda.`
          ).catch(waErr => console.error('CRON WA send error:', waErr.message));
        } catch (mikrotikErr) {
          console.error(`CRON Failed to isolate Mikrotik user ${invoice.mikrotik_username}:`, mikrotikErr.message);
        }
      }
    }
  );
});

/**
 * Task 4: Cek buka isolir untuk pelanggan lunas tiap jam 00.00
 * Runs daily at 00:00 AM
 */
cron.schedule('0 0 * * *', async () => {
  console.log('--- CRON: Checking for paid customers to reactivate from isolation ---');
  db.all(`SELECT c.id, c.name, c.whatsapp_number, c.mikrotik_username, c.mikrotik_profile_active
          FROM customers c
          WHERE c.status = 'isolated' AND c.mikrotik_profile_current = ?
          AND EXISTS (SELECT 1 FROM invoices i WHERE i.customer_id = c.id AND i.status = 'paid' ORDER BY i.due_date DESC LIMIT 1)`,
    [MIKROTIK_ISOLIR_PROFILE], async (err, customers) => {
      if (err) {
        console.error('CRON Error fetching isolated paid customers for reactivation:', err.message);
        return;
      }

      for (const customer of customers) {
        // Double check that the most recent *relevant* invoice is paid
        // This logic can be more complex, but for simplicity, we assume if *any* paid invoice exists, it's good.
        // In a real system, you'd check the *latest* invoice for the billing cycle.
        db.get(`SELECT * FROM invoices WHERE customer_id = ? AND status = 'paid' ORDER BY due_date DESC LIMIT 1`, [customer.id], async (err, latestPaidInvoice) => {
            if (err) {
                console.error(`CRON Error checking latest paid invoice for customer ${customer.id}:`, err.message);
                return;
            }
            if (latestPaidInvoice) {
                try {
                    await changeMikrotikProfile(customer.mikrotik_username, customer.mikrotik_profile_active);
                    db.run('UPDATE customers SET mikrotik_profile_current = ?, status = ? WHERE id = ?',
                        [customer.mikrotik_profile_active, 'active', customer.id],
                        (updateErr) => {
                            if (updateErr) console.error(`CRON Error updating customer ${customer.id} status to active:`, updateErr.message);
                            else console.log(`CRON: Reactivated Mikrotik user ${customer.mikrotik_username} for paid service.`);
                        }
                    );
                    sendWhatsAppMessage(customer.whatsapp_number,
                        `Halo ${customer.name}, layanan internet Anda sudah aktif kembali karena pembayaran Anda telah kami terima. Terima kasih!`
                    ).catch(waErr => console.error('CRON WA send error:', waErr.message));
                } catch (mikrotikErr) {
                    console.error(`CRON Failed to reactivate Mikrotik user ${customer.mikrotik_username}:`, mikrotikErr.message);
                }
            } else {
                console.log(`CRON: Customer ${customer.name} is isolated but no recent paid invoice found. Skipping reactivation.`);
            }
        });
      }
    }
  );
});

// --- End Cron Job Implementations ---

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  startWA(); // Start WhatsApp client on server launch
});
});