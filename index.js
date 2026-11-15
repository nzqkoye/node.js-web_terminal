"use strict";

const http = require("http");
const crypto = require("crypto");
const { spawn } = require("child_process");
const os = require("os");

const PORT = 3000;
const HOST = "127.0.0.1";

function log(msg) {
    process.stdout.write(`[WebTerminal] ${msg}\n`);
}

// ==================== 1. 解析命令行参数 ====================
let authEnabled = false;
let authUser = "";
let authPass = "";

const args = process.argv;
const cIndex = args.indexOf("-c");

if (cIndex !== -1 && args[cIndex + 1]) {
    const credentials = args[cIndex + 1].split("/");
    if (credentials.length === 2 && credentials[0] && credentials[1]) {
        authUser = credentials[0];
        authPass = credentials[1];
        authEnabled = true;
    } else {
        log("[ERROR] 参数格式错误！正确格式为: -c 用户名/密码");
        process.exit(1);
    }
}

// 身份验证
function authenticate(req) {
    if (!authEnabled) return true;
    const authHeader = req.headers["authorization"];
    if (!authHeader) return false;
    const match = authHeader.match(/^Basic\s+(.*)$/i);
    if (!match) return false;
    const credentials = Buffer.from(match[1], "base64").toString("ascii").split(":");
    return credentials[0] === authUser && credentials[1] === authPass;
}

// ==================== 2. 前端 HTML ====================
const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>Web Terminal</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
    <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
    <style>
        body { margin: 0; background: #1e1e1e; overflow: hidden; }
        #terminal { width: 100vw; height: 100vh; }
    </style>
</head>
<body>
    <div id="terminal"></div>
    <script>
        const term = new Terminal({
            cursorBlink: true,
            fontFamily: 'monospace',
            fontSize: 14,
            theme: { background: '#1e1e1e' }
        });
        term.open(document.getElementById('terminal'));

        const protocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        const socket = new WebSocket(protocol + window.location.host);

        socket.onopen = () => {
            term.write('*** 已成功连接到容器内网 (免依赖稳定版) ***\\r\\n');
            term.onData(data => socket.send(data));
        };
        socket.onmessage = event => {
            term.write(event.data);
        };
        socket.onclose = () => term.write('\\r\\n[连接已断开]\\r\\n');
    </script>
</body>
</html>`;

// ==================== 3. HTTP 服务 ====================
const server = http.createServer((req, res) => {
    if (!authenticate(req)) {
        res.writeHead(401, {
            "WWW-Authenticate": 'Basic realm="Secure Terminal"',
            "Content-Type": "text/plain; charset=utf-8"
        });
        return res.end("Unauthorized");
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(htmlContent);
});

// ==================== 4. 原生 WebSocket 协议实现 (免依赖) ====================
server.on("upgrade", (req, socket) => {
    if (!authenticate(req)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
    }

    const secKey = req.headers["sec-websocket-key"];
    if (!secKey) {
        socket.destroy();
        return;
    }

    // 握手响应
    const acceptValue = crypto
        .createHash("sha1")
        .update(secKey + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
        .digest("base64");

    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        "Sec-WebSocket-Accept: " + acceptValue + "\r\n\r\n"
    );

    // 封装极简 WebSocket 对象
    const ws = {
        socket,
        readyState: 1, // OPEN
        send: function (data) {
            if (this.readyState !== 1) return;
            const payload = Buffer.from(data, "utf-8");
            const len = payload.length;
            let header;
            if (len < 126) {
                header = Buffer.alloc(2);
                header[0] = 0x81; // FIN + Text Frame
                header[1] = len;
            } else if (len <= 65535) {
                header = Buffer.alloc(4);
                header[0] = 0x81;
                header[1] = 126;
                header.writeUInt16BE(len, 2);
            } else {
                header = Buffer.alloc(10);
                header[0] = 0x81;
                header[1] = 127;
                header.writeBigUInt64BE(BigInt(len), 2);
            }
            socket.write(Buffer.concat([header, payload]));
        },
        ping: function () {
            if (this.readyState === 1) {
                socket.write(Buffer.from([0x89, 0x00])); // Ping Frame
            }
        },
        close: function () {
            if (this.readyState === 1) {
                this.readyState = 3;
                socket.write(Buffer.from([0x88, 0x00])); // Close Frame
                socket.end();
            }
        },
        onmessage: null,
        onclose: null
    };

    // 心跳机制：每 20 秒发送一次底层 ping，防止 Cloudflare 闲置断线
    const keepAliveTimer = setInterval(() => {
        if (ws.readyState === 1) {
            ws.ping();
        } else {
            clearInterval(keepAliveTimer);
        }
    }, 20000);

    // 启动 Shell 进程 (Python PTY 虚拟终端)
    let shell = "sh";
    let shellArgs = [
        "-c",
        "python3 -c \"import pty; pty.spawn('/bin/bash')\" 2>/dev/null || python -c \"import pty; pty.spawn('/bin/bash')\" 2>/dev/null || bash -i || sh -i"
    ];

    const bash = spawn(shell, shellArgs, {
        env: Object.assign({}, process.env, { TERM: "xterm-256color" }),
        cwd: os.homedir()
    });

    bash.stdout.on("data", (data) => ws.send(data.toString("utf-8")));
    bash.stderr.on("data", (data) => ws.send(data.toString("utf-8")));

    // 解析客户端发送上来的 WebSocket 帧
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
            if (buffer.length < 2) return;
            const firstByte = buffer[0];
            const secondByte = buffer[1];
            const opcode = firstByte & 0x0F;
            const masked = (secondByte & 0x80) !== 0;
            let payloadLen = secondByte & 0x7F;

            let offset = 2;
            if (payloadLen === 126) {
                if (buffer.length < 4) return;
                payloadLen = buffer.readUInt16BE(2);
                offset = 4;
            } else if (payloadLen === 127) {
                if (buffer.length < 10) return;
                payloadLen = Number(buffer.readBigUInt64BE(2));
                offset = 10;
            }

            let maskKey;
            if (masked) {
                if (buffer.length < offset + 4) return;
                maskKey = buffer.slice(offset, offset + 4);
                offset += 4;
            }

            if (buffer.length < offset + payloadLen) return;
            const payload = buffer.slice(offset, offset + payloadLen);
            buffer = buffer.slice(offset + payloadLen);

            if (opcode === 0x8) { // 浏览器主动断开
                ws.readyState = 3;
                if (ws.onclose) ws.onclose();
                return;
            }

            if (opcode === 0x1 && bash.stdin.writable) { // 文本数据
                if (masked) {
                    for (let i = 0; i < payload.length; i++) {
                        payload[i] ^= maskKey[i % 4];
                    }
                }
                bash.stdin.write(payload.toString("utf-8"));
            }
        }
    });

    const cleanup = () => {
        ws.readyState = 3;
        clearInterval(keepAliveTimer);
        try { bash.kill(); } catch (e) {}
        if (ws.onclose) ws.onclose();
    };

    bash.on("close", cleanup);
    socket.on("close", cleanup);
    socket.on("error", cleanup);
});

server.listen(PORT, HOST, () => {
    log(`=========================================`);
    log(`原生免依赖 Web Terminal 运行在: http://${HOST}:${PORT}`);
    log(`=========================================`);
});
