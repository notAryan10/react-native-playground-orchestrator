# Orchestrator Setup Guide

The Orchestrator is the management layer that spins up private Docker containers for every user.

## 1. Prerequisites
- **Docker Desktop**: Must be running on your Mac.
- **Node.js**: Version 18 or higher.
- **Terminal**: Access to your project directory.

## 2. Prepare the Workspace Image
The Orchestrator expects a Docker image named `rn-playground-backend:latest`. You must build this first from your backend repository.

```bash
# Navigate to your backend directory
cd react-native-playground-backend-webrtcDemo

# Build the image
docker build -t rn-playground-backend:latest .
```

## 3. Install Orchestrator Dependencies
```bash
# Navigate to the orchestrator directory
cd orchestrator

# Install packages
npm install
```

## 4. Environment Configuration (Optional)
By default, the Orchestrator uses:
- `PORT=4000`: The API port.
- `BACKEND_IMAGE=rn-playground-backend:latest`: The image to spin up.

If you want to change these, create a `.env` file in the `orchestrator` folder:
```env
PORT=4000
BACKEND_IMAGE=rn-playground-backend:latest
```

## 5. Run the Orchestrator
```bash
npm run dev
```
You should see: `🚀 Docker Orchestrator ready on port 4000`

---

## 6. Verification
1. Ensure your **Frontend** is running (`npm run dev` in the frontend repo).
2. Open the browser to the frontend URL.
3. You should see an overlay: **"Provisioning your private workspace..."**
4. Check your Docker Desktop dashboard; you should see a new container named `workspace-con-user-xxxxx` start up automatically.
5. The terminal in the browser should connect shortly after.
