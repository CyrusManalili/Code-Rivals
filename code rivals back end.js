// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors'); // Import the cors package
const fetch = require('node-fetch'); // For making HTTP requests (e.g., to Gemini API)

const app = express();
const server = http.createServer(app);

// Use CORS middleware before Socket.IO to handle API requests
// Make sure CLIENT_URL is correctly set in your Render environment variables
app.use(cors({
    origin: process.env.CLIENT_URL || "http://localhost:8080", // Allow requests from your frontend
    methods: ["GET", "POST"]
}));

// Configure Socket.IO with CORS as well
const io = socketIo(server, {
    cors: {
        origin: process.env.CLIENT_URL || "http://localhost:8080",
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000; // Use port from environment variable or default to 3000
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Middleware to parse JSON bodies for incoming requests
app.use(express.json());

// --- MongoDB Connection ---
if (!MONGODB_URI) {
    console.error("MONGODB_URI is not defined in environment variables!");
    process.exit(1); // Exit the process if critical env var is missing
}

mongoose.connect(MONGODB_URI, {
    useNewUrlParser: true, // Deprecated in newer Mongoose versions, but good for older examples
    useUnifiedTopology: true,
})
    .then(() => console.log('MongoDB connected successfully!'))
    .catch(err => console.error('MongoDB connection error:', err));

// --- Mongoose User Schema and Model ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // WARNING: In production, hash this password!
    soloStage: { type: Number, default: 0 },
    elo: { type: Number, default: 1000 }
});
const User = mongoose.model('User', UserSchema);

// --- API Endpoints ---

// Root endpoint for health check
app.get('/', (req, res) => {
    res.send('Code Rivals Backend is running!');
});

// Signup Endpoint
app.post('/api/signup', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }
    try {
        const existingUser = await User.findOne({ username });
        if (existingUser) {
            return res.status(409).json({ message: 'Username already exists. Please choose a different one.' });
        }
        // In a real application, you would hash the password here before saving!
        const newUser = new User({ username, password });
        await newUser.save();
        res.status(201).json({ message: 'User created successfully!' });
    } catch (error) {
        console.error('Signup error:', error.message);
        res.status(500).json({ message: 'Server error during signup. Please try again.' });
    }
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ message: 'Username and password are required.' });
    }
    try {
        const user = await User.findOne({ username });
        // In a real application, you would compare hashed passwords here!
        if (!user || user.password !== password) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        // Return user data (excluding password)
        res.status(200).json({
            message: 'Login successful!',
            user: {
                username: user.username,
                soloStage: user.soloStage,
                elo: user.elo
            }
        });
    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ message: 'Server error during login. Please try again.' });
    }
});

// Update User Data Endpoint (for soloStage, ELO updates)
app.post('/api/update-user-data', async (req, res) => {
    const { username, soloStage, elo } = req.body;
    if (!username) {
        return res.status(400).json({ message: 'Username is required.' });
    }
    try {
        const user = await User.findOneAndUpdate(
            { username },
            { $set: { soloStage, elo } }, // Update soloStage and ELO
            { new: true } // Return the updated document
        );
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json({ message: 'User data updated successfully!', user: { username: user.username, soloStage: user.soloStage, elo: user.elo } });
    } catch (error) {
        console.error('Update user data error:', error.message);
        res.status(500).json({ message: 'Server error during user data update.' });
    }
});

// Gemini API Proxy Endpoint
app.post('/api/gemini-proxy', async (req, res) => {
    const { prompt, currentCode, expectedOutput } = req.body;

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ success: false, message: "Gemini API Key is not configured on the server." });
    }

    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    try {
        const fullPrompt = `You are a C++ code evaluator. Evaluate the following C++ code provided by a user for a solo challenge.
        Problem Description: "${prompt}"
        User's Code:
        \`\`\`cpp
        ${currentCode}
        \`\`\`
        Expected Output: "${expectedOutput}"

        Please compile and run the user's code (simulated). Based on the output, determine if the user's code correctly solves the problem and matches the expected output.
        Provide a concise response indicating:
        1. Whether the code is correct or incorrect.
        2. If incorrect, a brief explanation of why, or a hint (do not give the full solution).
        3. If correct, just say "Correct!".

        Example of correct output: "Correct!"
        Example of incorrect output: "Incorrect. Your code printed 'Hello' but expected 'Hello, World!'."
        `;

        const geminiResponse = await fetch(GEMINI_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: fullPrompt }]
                }]
            })
        });

        const geminiData = await geminiResponse.json();

        // Safely extract the evaluation result
        const evaluationResult = geminiData.candidates && geminiData.candidates[0] &&
                               geminiData.candidates[0].content && geminiData.candidates[0].content.parts[0] &&
                               geminiData.candidates[0].content.parts[0].text ?
                               geminiData.candidates[0].content.parts[0].text : 'No clear evaluation from AI.';

        res.json({ success: true, evaluation: evaluationResult });

    } catch (error) {
        console.error('Error calling Gemini API:', error);
        res.status(500).json({ success: false, message: 'Failed to get evaluation from AI.' });
    }
});


// --- Socket.IO for Real-time Multiplayer and Chat ---
let connectedUsers = {}; // { socketId: { username, elo } }
let lobbyChatMessages = []; // Simple in-memory chat history for the lobby
const MAX_CHAT_HISTORY = 50;

// Function to get and sort global leaderboard
async function getGlobalLeaderboard() {
    try {
        const users = await User.find({}, 'username elo').sort({ elo: -1 }).limit(10); // Get top 10 by ELO
        return users.map(user => ({ username: user.username, elo: user.elo }));
    } catch (error) {
        console.error("Error fetching global leaderboard:", error);
        return [];
    }
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send existing chat history to the newly connected client
    socket.emit('chat history', lobbyChatMessages);

    // When a player is "connected" (logged in and explicitly joining the real-time layer)
    socket.on('player_connected', async (data) => {
        connectedUsers[socket.id] = { username: data.username, elo: data.elo };
        console.log(`${data.username} (${socket.id}) joined the real-time session.`);
        // Broadcast a message to chat that user joined (optional)
        io.emit('chat message', `[SERVER] ${data.username} has joined the lobby.`);

        // Immediately send global leaderboard to new user and all others
        const leaderboard = await getGlobalLeaderboard();
        io.emit('global_leaderboard_update', leaderboard);
    });

    // Handle chat messages
    socket.on('chat message', (msg) => {
        const sender = connectedUsers[socket.id] ? connectedUsers[socket.id].username : 'Anonymous';
        const messageWithSender = `${sender}: ${msg.message}`;
        lobbyChatMessages.push(messageWithSender);
        if (lobbyChatMessages.length > MAX_CHAT_HISTORY) {
            lobbyChatMessages.shift(); // Remove oldest message
        }
        io.emit('chat message', messageWithSender); // Broadcast to all connected clients
    });

    // Handle requests for global leaderboard
    socket.on('request_global_leaderboard', async () => {
        const leaderboard = await getGlobalLeaderboard();
        socket.emit('global_leaderboard_update', leaderboard); // Send only to the requesting client
    });

    // --- Multiplayer Game Logic (Simplified) ---
    // For a simple demo, you might just broadcast game updates to all
    // For actual lobbies and games, you'd implement rooms:
    // socket.join('room-id');
    // io.to('room-id').emit('game_update', data);

    socket.on('game_action', (data) => {
        // This is where your actual game state management would happen on the server.
        // For example, validating player moves, answers, updating score, checking win conditions.
        // Then, you'd emit updates back to the relevant players/room.

        // Example: If player answers a question
        console.log(`Player ${connectedUsers[socket.id]?.username || socket.id} submitted answer:`, data);

        // For now, let's just broadcast a generic update to simulate
        // In a real game, you'd manage the game turn, check correctness, update player scores/lives etc.
        io.emit('game_state_update', {
            type: 'player_action',
            username: connectedUsers[socket.id]?.username,
            action: data.action, // e.g., 'submit_answer', 'timeout'
            // ... more game specific data
        });
    });


    socket.on('disconnect', async () => {
        console.log(`User disconnected: ${socket.id}`);
        const disconnectedUser = connectedUsers[socket.id];
        if (disconnectedUser) {
            delete connectedUsers[socket.id];
            io.emit('chat message', `[SERVER] ${disconnectedUser.username} has left the lobby.`);
        }
        // Update and send global leaderboard after disconnect
        const leaderboard = await getGlobalLeaderboard();
        io.emit('global_leaderboard_update', leaderboard);
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});