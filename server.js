// --- [1] IMPORTAÇÕES E CONFIGURAÇÃO INICIAL ---

// Baileys e componentes para o WhatsApp
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');

// Servidor Web e comunicação em tempo real
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors'); // Essencial para o frontend separado

// Banco de dados e variáveis de ambiente
const mongoose = require('mongoose');
require('dotenv').config();
const pino = require('pino'); // Logger usado pelo Baileys

// --- [2] CONFIGURAÇÃO DO BANCO DE DADOS (MONGODB) ---

// Conecta ao MongoDB usando a URL do arquivo .env
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB conectado com sucesso.'))
    .catch(err => console.error('Erro ao conectar com MongoDB:', err));

// Define a estrutura (Schema) para armazenar os números no banco
const NumberSchema = new mongoose.Schema({
    phoneNumber: { type: String, required: true, unique: true },
    status: { type: String, default: 'pending' } // Status: 'pending', 'sent', 'failed'
});
// Cria o Modelo a partir do Schema, que será usado para interagir com a coleção 'numbers'
const NumberModel = mongoose.model('Number', NumberSchema);


// --- [3] CONFIGURAÇÃO DO SERVIDOR WEB E SOCKET.IO ---

const app = express();
const server = http.createServer(app);

// Habilita CORS para permitir que o frontend (em outro domínio/porta) acesse esta API
app.use(cors());

// Configura o Socket.IO com CORS para permitir a conexão do frontend
const io = new Server(server, {
    cors: {
        origin: "*", // ATENÇÃO: Em produção, troque "*" pelo domínio do seu frontend por segurança.
        methods: ["GET", "POST"]
    }
});

// --- [4] LÓGICA PRINCIPAL DO WHATSAPP (BAILEYS) ---

let sock; // Variável para armazenar a instância da conexão do WhatsApp
let isSending = false; // Flag para controlar se um envio está em progresso
let stopSending = false; // Flag para solicitar a parada do envio

async function connectToWhatsApp() {
    // `useMultiFileAuthState` salva a sessão (credenciais) em arquivos para não precisar escanear o QR code toda vez
    // LINHA CORRIGIDA
const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth_info_baileys');
    
    sock = makeWASocket({
        logger: pino({ level: 'silent' }), // 'silent' para não poluir o console com logs do Baileys
        printQRInTerminal: true, // Mostra o QR no terminal como uma alternativa
        auth: state,
        browser: Browsers.macOS('Desktop'), // Simula um navegador para a conexão
    });

    // Salva as credenciais sempre que elas forem atualizadas
    sock.ev.on('creds.update', saveCreds);

    // Monitora o status da conexão
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            console.log('QR Code recebido, enviando para o frontend...');
            // Envia o QR code via Socket.IO para ser exibido no frontend
            io.emit('qr', qr);
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('Conexão fechada: ', lastDisconnect.error, ', reconectando: ', shouldReconnect);
            // Se a desconexão não foi um logout, tenta reconectar
            if (shouldReconnect) {
                connectToWhatsApp();
            } else {
                 io.emit('status', 'Conexão encerrada (logout). Por favor, reinicie o servidor e escaneie o QR Code novamente.');
                 console.log('Conexão fechada permanentemente. Limpe a pasta auth_info_baileys e reinicie.');
            }
        } else if (connection === 'open') {
            console.log('Conexão com o WhatsApp estabelecida!');
            io.emit('status', 'Conectado ao WhatsApp com sucesso!');
        }
    });

    // Ouve eventos vindos do frontend
    io.on('connection', (socket) => {
        console.log('Um cliente frontend se conectou via Socket.IO');

        // Quando o usuário clica em "Iniciar Envio" no frontend
        socket.on('start-sending', async (data) => {
            if (isSending) {
                io.emit('log', 'AVISO: Um processo de envio já está em andamento.');
                return;
            }
            
            isSending = true;
            stopSending = false;
            io.emit('status', 'Iniciando processo de envio...');
            await prepareAndSend(data); // Chama a função que prepara os números e inicia o envio
            isSending = false;
        });

        // Quando o usuário clica em "Parar Envio"
        socket.on('stop-sending', () => {
            if (isSending) {
                stopSending = true;
                io.emit('log', 'Sinal de parada recebido. O envio será interrompido após a mensagem atual.');
            }
        });
    });
}

// --- [5] FUNÇÕES DE APOIO (GERAÇÃO DE NÚMEROS E ENVIO) ---

function generateMozambiqueNumbers(count) {
    const numbers = new Set();
    const prefixes = ['84', '82', '85', '86', '87']; // Principais prefixos de Moçambique
    while (numbers.size < count) {
        const randomPrefix = prefixes[Math.floor(Math.random() * prefixes.length)];
        const randomNumber = Math.floor(1000000 + Math.random() * 9000000).toString().padStart(7, '0');
        numbers.add(`+258${randomPrefix}${randomNumber}`);
    }
    return Array.from(numbers);
}

async function prepareAndSend(data) {
    const { message, quantity, source, numberList, imageUrl } = data; // imageUrl para futura implementação de imagem

    try {
        // Limpa a coleção de números de sessões anteriores
        await NumberModel.deleteMany({});
        io.emit('log', 'Limpando lista de números da sessão anterior...');

        let numbersToProcess = [];
        if (source === 'random') {
            numbersToProcess = generateMozambiqueNumbers(parseInt(quantity, 10));
        } else { // 'paste' ou 'file'
            // Divide a lista por espaços, vírgulas, ponto e vírgula ou quebras de linha
            numbersToProcess = numberList.split(/[\s,;\n]+/).filter(n => n.trim() !== '');
        }

        if (numbersToProcess.length === 0) {
            io.emit('log', 'Nenhum número válido para processar.');
            io.emit('status', 'Falha: Lista de números vazia.');
            isSending = false;
            return;
        }

        // Salva os novos números no banco com status 'pending'
        const numberDocs = numbersToProcess.map(num => ({ phoneNumber: num, status: 'pending' }));
        await NumberModel.insertMany(numberDocs, { ordered: false }).catch(() => {
             io.emit('log', 'Números duplicados foram ignorados.');
        });

        io.emit('log', `${await NumberModel.countDocuments()} números foram carregados para a sessão.`);
        await startSendingProcess(message, imageUrl);

    } catch (error) {
        console.error('Erro ao preparar para o envio:', error);
        io.emit('log', `ERRO CRÍTICO: ${error.message}`);
        io.emit('status', 'Ocorreu um erro. Verifique o console do servidor.');
        isSending = false;
    }
}

async function startSendingProcess(message, imageUrl) {
    const total = await NumberModel.countDocuments();
    let sentCount = 0;
    let failedCount = 0;
    
    // A resiliência é garantida aqui: o cursor sempre busca por números com status 'pending'.
    // Se o processo parar, na próxima vez ele continuará de onde parou.
    const cursor = NumberModel.find({ status: 'pending' }).cursor();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
        if (stopSending) {
            io.emit('status', 'Envio interrompido pelo usuário.');
            console.log('Processo de envio interrompido.');
            stopSending = false;
            isSending = false;
            return;
        }

        const number = doc.phoneNumber;
        let status = 'failed';

        try {
            // Passo 1: Verifica se o número tem uma conta no WhatsApp
            const [result] = await sock.onWhatsApp(number);

            if (result?.exists) {
                // Passo 2: Envia a mensagem
                // TODO: Implementar lógica de envio de imagem se imageUrl existir
                await sock.sendMessage(result.jid, { text: message });
                
                status = 'sent';
                sentCount++;
                io.emit('log', `SUCESSO: Mensagem enviada para ${number}`);
            } else {
                failedCount++;
                io.emit('log', `FALHA: Número ${number} não existe no WhatsApp.`);
            }

            // Passo 3: Atualiza o status do número no banco de dados
            await NumberModel.updateOne({ _id: doc._id }, { $set: { status: status } });

        } catch (error) {
            failedCount++;
            await NumberModel.updateOne({ _id: doc._id }, { $set: { status: 'failed' } });
            console.error(`Erro ao enviar para ${number}:`, error);
            io.emit('log', `ERRO ao processar ${number}. Verifique o console do servidor.`);
        }
        
        // Passo 4: Emite o progresso para o frontend
        const remaining = total - (sentCount + failedCount);
        io.emit('progress', { sent: sentCount, failed: failedCount, total: total, remaining: remaining });

        // Passo 5: Delay aleatório para simular comportamento humano e evitar bloqueios
        const delay = Math.floor(Math.random() * (10000 - 3000 + 1) + 3000); // Entre 3 e 10 segundos
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    io.emit('status', 'Processo de envio concluído!');
    console.log('Todos os números da lista foram processados.');
    isSending = false;
}

// --- [6] INICIALIZAÇÃO DO SERVIDOR ---

// Inicia a conexão com o WhatsApp
connectToWhatsApp().catch(err => console.error("Erro fatal ao iniciar a conexão com o WhatsApp: ", err));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor backend rodando na porta ${PORT}`));