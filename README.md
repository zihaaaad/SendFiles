# SendFiles P2P: Secure Zero-Configuration File Sharing

SendFiles P2P is a zero-configuration peer-to-peer file sharing application. It enables instant device discovery on local networks and secure, direct-channel file transfers via WebRTC. For networks with restrictive NAT configurations, the application automatically rolls back to an asynchronous WebSocket chunk relay.

The frontend is implemented as a single-page application built on React 19, Tailwind CSS v4, and Motion. The backend is powered by an Express server that acts as a WebSocket signaling gateway and provides a public IP discovery endpoint.

---

## Primary Capabilities

### Direct Beam (Instant P2P)
- **Zero Configuration**: Devices connected to the same Wi-Fi network discover and pair with each other automatically based on their shared public IP.
- **Node Discovery**: Discovers nearby or remote peers, allowing you to select a node and immediately stream files.
- **Dynamic Presence**: Updates the peer registry in real-time as devices join or leave the signaling channel.

### Encrypted Locker Vaults (Zero-Knowledge)
- **Multi-File Packages**: Allows bundling multiple files into a single locker envelope.
- **Client-Side Cryptography**: Files are encrypted in-browser chunk-by-chunk using AES-256-GCM via the Web Cryptography API.
- **Zero-Knowledge Architecture**: The 256-bit symmetric decryption key is appended to the URL hash segment (e.g., `#/locker/ID#key=HEX_KEY`). Because browsers do not transmit hash fragments to servers, the decryption key remains strictly client-side.
- **Self-Destruct Constraints**: Supports download limit quotas (1 to 50 downloads, or unlimited) and expiration timers (10 minutes to 24 hours). Once conditions are met, the locker registry is pruned from the server.
- **Passcode Authentication**: Enables an optional secondary passcode hashed with SHA-256 client-side to verify receiver identity before initiating WebRTC handshakes.

### Performance & Scaling
- **IndexedDB Buffering**: Caches incoming file chunks directly onto client disk storage via IndexedDB. This bypasses browser heap memory constraints, enabling transfers of large files (10GB+) without memory exhaustion.
- **Flow Control (Backpressure)**: Monitors WebRTC data channel congestion (`RTCDataChannel.bufferedAmount`). Transmissions are paused when the buffer exceeds 1MB and resumed once it drains, preventing packet loss.
- **Progress Metrics**: Estimates and displays accurate real-time transfer progress, speed, and remaining time (ETA).

---

## Systems Architecture

### WebRTC Room Signaling Flow

```mermaid
sequenceDiagram
    autonumber
    participant Sender as Sender (Locker Dashboard)
    participant Server as Express Signaling Server
    participant Receiver as Receiver (Reception Panel)

    Note over Sender,Receiver: 1. Locker Creation
    Sender->>Server: HTTP POST /api/rooms (files metadata, password hash)
    Server-->>Sender: 201 Created (RoomID, Expiry)
    Note over Sender: Generates AES-256 key, creates hash link
    
    Note over Sender,Receiver: 2. Receiver Joins Room
    Receiver->>Server: HTTP GET /api/rooms/RoomID (Verify locker exists)
    Server-->>Receiver: Locker status (password required/optional)
    Receiver->>Server: WebSocket Connect ?roomId=RoomID&role=receiver
    Server->>Sender: WS Relay "peer-joined" (sharing Receiver's peerId)
    
    Note over Sender,Receiver: 3. WebRTC Negotiation
    Sender->>Server: WS Relay "offer" (targeting Receiver's peerId)
    Server->>Receiver: WS Relay "offer"
    Receiver->>Server: WS Relay "answer" (omitting targetPeerId, routed via room)
    Server->>Sender: WS Relay "answer"
    Sender->>Server: WS Relay ICE candidates
    Receiver->>Server: WS Relay ICE candidates
    
    Note over Sender,Receiver: 4. Direct E2E Encrypted Data Stream
    Sender->>Receiver: WebRTC Data Channel (AES-256-GCM encrypted chunks)
    Receiver-->>Sender: WebRTC Data Channel ACKs (flow control backpressure)
    Note over Receiver: Buffers to IndexedDB, compiles Blob, triggers download
```

---

## Local Configuration & Development

To run the application locally, follow these steps:

### Prerequisites
- Node.js (Version 18 or higher recommended)

### Installation & Launching

#### Option A: One-Click Launchers (Simplified)
For a simplified setup that checks for Node.js, installs any missing dependencies, and launches the development server automatically:
- **Windows**: Double-click the `run-windows.bat` launcher in the project root.
- **Linux / macOS**: Run the launcher from your terminal:
  ```bash
  chmod +x run-linux.sh
  ./run-linux.sh
  ```

#### Option B: Manual Commands
1. Clone the repository and navigate into the project directory.
2. Install the Node dependencies:
   ```bash
   npm install
   ```
3. Start the development server:
   ```bash
   npm run dev
   ```
   This compiles the frontend assets and starts the Express signaling server on port 3000.
4. Access the application:
   Open http://localhost:3000 in your browser.

### Testing Across Local Wi-Fi Devices
To test file sharing between two local devices:
1. Ensure both devices are connected to the same Wi-Fi network.
2. Identify the local IPv4 address of the host machine (e.g., `192.168.1.50`).
3. Open the browser on your mobile or secondary device and navigate to: `http://192.168.1.50:3000`.
4. The two devices will pair and appear in each other's Direct Beam discovery tab.

---

## Production Build & Hosting

To build the static bundle and start the production server:

```bash
npm run build
npm start
```

### Hosting Guidelines
Because the signaling channel relies on persistent WebSocket connections:
- **Recommended Providers**: Google Cloud Run, Railway, Render, Fly.io, Heroku, or virtual private servers (VPS).
- **Serverless Warning**: Standard serverless platforms (such as static Vercel or Netlify configurations) do not support persistent WebSockets and are not suitable for hosting the Express signaling backend.
- **HTTPS/WSS Requirements**: WebRTC APIs require secure contexts. In production, ensure the server is behind an SSL termination proxy so that assets are served over HTTPS and WebSockets dial over WSS.

---

## Security Specifications

1. **Symmetric Encryption**: Chunks are encrypted using AES-GCM (256-bit key).
2. **Ephemeral Key Distribution**: The encryption key is stored solely in the URL hash fragment. Because hash parameters are not sent to the server in HTTP requests, the backend has zero-knowledge of the keys.
3. **Password Security**: Room passcodes are hashed with SHA-256 client-side. The cleartext passcode is never transmitted over the network.
