const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const API_URL = 'https://dongwonk5.sg-host.com/wp-json/custom/v1';
const TOKEN_FILE = './jwt_token.txt';
let JWT_TOKEN = null;
let pollingInterval = null;

function log(message) {
    console.log(message);
    io.emit('log', message);
}

app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const response = await axios.post(`${API_URL}/login`, { username, password }, {
            headers: { 'Content-Type': 'application/json' },
            withCredentials: true
        });
        JWT_TOKEN = response.headers['set-cookie'][0].split(';')[0].split('=')[1];
        fs.writeFileSync(TOKEN_FILE, JWT_TOKEN); // 토큰 저장
        log('Login successful');
        res.json({ status: 'success', message: 'Logged in' });
    } catch (error) {
        log(`Login error: ${error.response?.data?.message || error.message}`);
        res.status(401).json({ status: 'error', message: 'Login failed' });
    }
});

app.get('/start', (req, res) => {
    if (!JWT_TOKEN) {
        log('Please login first');
        return res.status(401).json({ status: 'error', message: 'Not authenticated' });
    }
    if (!pollingInterval) {
        log('Starting server...');
        pollOrders();
        pollingInterval = setInterval(pollOrders, 5000);
        io.emit('status', 'Running'); // 상태 업데이트
        res.json({ status: 'started' });
    } else {
        log('Server already running.');
        res.json({ status: 'already_running' });
    }
});

app.get('/stop', (req, res) => {
    if (pollingInterval) {
        clearInterval(pollingInterval);
        pollingInterval = null;
        log('Server stopped.');
        io.emit('status', 'Stopped'); // 상태 업데이트
        res.json({ status: 'stopped' });
    } else {
        log('Server not running.');
        res.json({ status: 'not_running' });
    }
});

async function pollOrders() {
    try {
        const response = await axios.get(`${API_URL}/pending-orders`, {
            headers: {
                'Cookie': `jwt_token=${JWT_TOKEN}`,
                'Content-Type': 'application/json'
            },
            withCredentials: true
        });
        const orders = response.data;
        const time = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Vancouver' });

        if (orders.length > 0) {
            log(`Found ${orders.length} new orders`);
            orders.forEach(order => {
                if (!order.print_status) { // 중복 출력 방지
                    log(`Order #${order.order_number} detected (printing skipped)`);
                    // 실제 프린터 연결 시 여기에 printOrder(order) 호출
                } else {
                    log(`Order #${order.order_number} already printed`);
                }
            });
        } else {
            log(`${time}: No new order.`);
        }
    } catch (error) {
        log(`Polling error: ${error.response?.status || error.message}`);
        io.emit('error', 'Failed to fetch orders'); // 에러 알림
    }
}

// 서버 시작 시 토큰 로드
if (fs.existsSync(TOKEN_FILE)) {
    JWT_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8');
    log('Loaded saved token');
}

server.listen(3000, () => {
    log('Server running on http://localhost:3000');
    io.emit('status', pollingInterval ? 'Running' : 'Stopped'); // 초기 상태
});

io.on('connection', (socket) => {
    log('Client connected to WebSocket');
    socket.on('disconnect', () => log('Client disconnected'));
});