// Load environment variables from .env file
// In production on Render, these are set in the Render dashboard, not from a .env file.
require('dotenv').config();

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors'); // Import the cors package
const fetch = require('node-fetch'); // For making HTTP requests (e.g., to Gemini API)
// const bcrypt = require('bcrypt'); // RECOMMENDED: Uncomment and use this for password hashing!

const app = express();
const server = http.createServer(app);

// Use CORS middleware before Socket.IO to handle API requests
// This allows your frontend (CLIENT_URL) to make HTTP requests to this backend.
app.use(cors({
    origin: process.env.CLIENT_URL || "https://code-rivals-4jf9.onrender.com", // Allow requests from your frontend
    methods: ["GET", "POST"]
}));

// Configure Socket.IO with CORS as well
// This allows your frontend to establish WebSocket connections for real-time features.
const io = socketIo(server, {
    cors: {
        origin: process.env.CLIENT_URL || "https://code-rivals-4jf9.onrender.com",
        methods: ["GET", "POST"]
    }
});

// Load environment variables from process.env
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

// Middleware to parse JSON bodies for incoming requests
app.use(express.json());

// --- MongoDB Connection ---
if (!MONGODB_URI) {
    console.error("MONGODB_URI is not defined in environment variables!");
    // In a production environment, you might want more graceful error handling
    // or a health check endpoint to reflect this status.
    process.exit(1); // Exit the process if critical env var is missing
}

mongoose.connect(MONGODB_URI, {
    // useNewUrlParser and useUnifiedTopology are largely deprecated in recent Mongoose versions (v6+)
    // but are harmless to keep for backward compatibility.
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
    .then(() => console.log('MongoDB connected successfully!'))
    .catch(err => console.error('MongoDB connection error:', err.message || err)); // Log full error message

// --- Mongoose User Schema and Model ---
const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    // WARNING: CRITICAL SECURITY VULNERABILITY!
    // In production, you MUST hash this password using a library like bcrypt.
    // Example: password: { type: String, required: true }, // After hashing: storing the hash here
    password: { type: String, required: true }, // Current plain text storage
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

        // --- IMPORTANT SECURITY NOTE ---
        // In a real application, you would hash the password here before saving!
        // const hashedPassword = await bcrypt.hash(password, 10); // 10 is the salt rounds
        // const newUser = new User({ username, password: hashedPassword });
        const newUser = new User({ username, password }); // Current plain text storage - DO NOT USE IN PRODUCTION

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

        // --- IMPORTANT SECURITY NOTE ---
        // In a real application, you would compare hashed passwords here!
        // const isMatch = user && await bcrypt.compare(password, user.password);
        // if (!user || !isMatch) {
        if (!user || user.password !== password) { // Current plain text comparison - DO NOT USE IN PRODUCTION
            return res.status(401).json({ message: 'Invalid username or password.' });
        }

        // Return user data (excluding password for security)
        res.status(200).json({
            message: 'Login successful!',
            user: {
                username: user.username,
                soloStage: user.soloStage,
                elo: user.elo
            }
            // In a real app, you would generate and return a JWT here for session management
        });
    } catch (error) {
        console.error('Login error:', error.message);
        res.status(500).json({ message: 'Server error during login. Please try again.' });
    }
});

// Update User Data Endpoint (for soloStage, ELO updates)
// WARNING: This endpoint is currently UNPROTECTED. Any client could update any user's data
// if they know the username. Implement authentication (e.g., JWT) to secure this.
app.post('/api/update-user-data', async (req, res) => {
    const { username, soloStage, elo } = req.body;

    if (!username) {
        return res.status(400).json({ message: 'Username is required.' });
    }

    // Basic validation for soloStage and elo
    if (typeof soloStage !== 'number' || typeof elo !== 'number') {
        return res.status(400).json({ message: 'soloStage and elo must be numbers.' });
    }

    try {
        // Find and update the user by username
        const user = await User.findOneAndUpdate(
            { username },
            { $set: { soloStage, elo } }, // Use $set to update specific fields
            { new: true, runValidators: true } // new: true returns the updated document, runValidators ensures schema validation
        );

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.status(200).json({
            message: 'User data updated successfully!',
            user: { username: user.username, soloStage: user.soloStage, elo: user.elo }
        });
    } catch (error) {
        console.error('Update user data error:', error.message);
        res.status(500).json({ message: 'Server error during user data update.' });
    }
});

// Gemini API Proxy Endpoint for C++ Code Evaluation
// WARNING: This endpoint is currently UNPROTECTED. Anyone can call it, potentially leading
// to abuse of your Gemini API quota. Implement authentication to secure this.
app.post('/api/gemini-proxy', async (req, res) => {
    const { prompt, currentCode, expectedOutput } = req.body;

    if (!GEMINI_API_KEY) {
        return res.status(500).json({ success: false, message: "Gemini API Key is not configured on the server." });
    }
    if (!prompt || !currentCode || !expectedOutput) {
        return res.status(400).json({ success: false, message: "Missing required parameters: prompt, currentCode, or expectedOutput." });
    }

    const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    try {
        const fullPrompt = `You are a C++ code evaluator. Your task is to analyze a user's C++ code and determine if it correctly solves a given problem, specifically by checking if its simulated output matches the expected output.

Problem Description: "${prompt}"
User's Code:
\`\`\`cpp
${currentCode}
\`\`\`
Expected Output: "${expectedOutput}"

Based on a simulated compilation and execution of the user's code, provide a concise evaluation.
Your response should clearly state:
1. "Correct!" if the user's code is logically sound and its simulated output exactly matches the Expected Output.
2. If the code is incorrect or the simulated output does not match, provide "Incorrect." followed by a brief, helpful explanation of the discrepancy or a hint on what might be wrong, without giving away the full solution. Focus on output mismatches or common C++ errors (e.g., syntax, logic leading to wrong output).

Example of a correct response: "Correct!"
Example of an incorrect response: "Incorrect. Your code printed 'Hello' but the expected output was 'Hello, World!'. Check your string literal."
Example for a logical error: "Incorrect. Your code calculates the sum incorrectly. Review the loop condition or the summation logic."
Example for a syntax error: "Incorrect. There appears to be a syntax error in your code, specifically missing a semicolon on line X or an unclosed bracket."
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

        // Safely extract the evaluation result from Gemini's response
        const evaluationResult = geminiData.candidates && geminiData.candidates[0] &&
                                 geminiData.candidates[0].content && geminiData.candidates[0].content.parts[0] &&
                                 geminiData.candidates[0].content.parts[0].text ?
                                 geminiData.candidates[0].content.parts[0].text : 'No clear evaluation from AI. Please try again.';

        res.json({ success: true, evaluation: evaluationResult });

    } catch (error) {
        console.error('Error calling Gemini API:', error);
        res.status(500).json({ success: false, message: `Failed to get evaluation from AI: ${error.message}` });
    }
});


// --- Socket.IO for Real-time Multiplayer and Chat ---
let connectedUsers = {}; // Stores { socketId: { username, elo } } for active connections
let lobbyChatMessages = []; // Simple in-memory chat history for the lobby
const MAX_CHAT_HISTORY = 50; // Maximum number of chat messages to keep in history

/**
 * Fetches the top 10 users from the database based on ELO score.
 * @returns {Array} An array of user objects with username and elo.
 */
async function getGlobalLeaderboard() {
    try {
        // Fetch users, select only username and elo, sort by elo descending, limit to 10
        const users = await User.find({}, 'username elo').sort({ elo: -1 }).limit(10);
        return users.map(user => ({ username: user.username, elo: user.elo }));
    } catch (error) {
        console.error("Error fetching global leaderboard:", error);
        return []; // Return empty array on error
    }
}

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Send existing chat history to the newly connected client
    socket.emit('chat history', lobbyChatMessages);

    // When a player is "connected" (logged in and explicitly joining the real-time layer)
    // WARNING: This assumes the client sends correct username/elo.
    // In a secure app, this would be based on server-side session or JWT.
    socket.on('player_connected', async (data) => {
        if (data.username) {
            connectedUsers[socket.id] = { username: data.username, elo: data.elo || 1000 };
            console.log(`${data.username} (${socket.id}) joined the real-time session.`);
            // Broadcast a message to chat that user joined
            io.emit('chat message', `[SERVER] ${data.username} has joined the lobby.`);
        } else {
            console.warn(`player_connected event received without username for socket ${socket.id}`);
        }

        // Immediately send global leaderboard to new user and all others
        const leaderboard = await getGlobalLeaderboard();
        io.emit('global_leaderboard_update', leaderboard);
    });

    // Handle incoming chat messages from clients
    socket.on('chat message', (msg) => {
        const sender = connectedUsers[socket.id] ? connectedUsers[socket.id].username : 'Anonymous';
        const messageText = msg.message ? String(msg.message).trim() : ''; // Ensure message is a string and trim whitespace

        if (messageText) { // Only process non-empty messages
            const messageWithSender = `${sender}: ${messageText}`;
            lobbyChatMessages.push(messageWithSender);
            // Keep chat history within the maximum limit
            while (lobbyChatMessages.length > MAX_CHAT_HISTORY) {
                lobbyChatMessages.shift(); // Remove the oldest message
            }
            io.emit('chat message', messageWithSender); // Broadcast to all connected clients
        }
    });

    // Handle requests for global leaderboard from clients
    socket.on('request_global_leaderboard', async () => {
        const leaderboard = await getGlobalLeaderboard();
        socket.emit('global_leaderboard_update', leaderboard); // Send only to the requesting client
    });

    // --- Multiplayer Game Logic (Simplified Placeholder) ---
    // This section is a placeholder for more complex game state management.
    // For actual lobbies and game rooms, you'd implement:
    // - socket.join('room-id'); // To join specific game rooms
    // - io.to('room-id').emit('game_update', data); // To send updates only to that room

    socket.on('game_action', (data) => {
        // This is where your actual game state management would happen on the server.
        // For example, validating player moves, answers, updating score, checking win conditions.
        // Then, you'd emit updates back to the relevant players/room.

        console.log(`Player ${connectedUsers[socket.id]?.username || socket.id} submitted game action:`, data);

        // For now, let's just broadcast a generic update to simulate
        // In a real game, you'd manage the game turn, check correctness, update player scores/lives etc.
        io.emit('game_state_update', {
            type: data.type, // e.g., 'submit_answer', 'player_turn', 'game_end'
            username: connectedUsers[socket.id]?.username,
            ...data // Pass through any other data from the client
        });
    });

    // Handle user disconnection
    socket.on('disconnect', async () => {
        console.log(`User disconnected: ${socket.id}`);
        const disconnectedUser = connectedUsers[socket.id];
        if (disconnectedUser) {
            delete connectedUsers[socket.id];
            io.emit('chat message', `[SERVER] ${disconnectedUser.username} has left the lobby.`);
        }
        // Update and send global leaderboard after a user disconnects
        const leaderboard = await getGlobalLeaderboard();
        io.emit('global_leaderboard_update', leaderboard);
    });
});

// Start the server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
