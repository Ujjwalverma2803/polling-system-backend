# RAG-Powered News Chatbot - Backend

## Overview
This is the backend for a RAG (Retrieval-Augmented Generation) powered chatbot over news articles.  
It handles:
- Embedding user queries
- Retrieving top news passages from Qdrant
- Communicating with Google Gemini API for final responses
- Managing chat sessions with Redis

---

## Tech Stack
- **Backend:** Node.js + Express
- **Embeddings:** Python microservice using `SentenceTransformers` (`all-MiniLM-L6-v2`)
- **Vector Database:** Qdrant
- **LLM API:** Google Gemini API
- **Session & Cache:** Redis
- **Containerization:** Docker & Docker Compose

---

## Prerequisites
- Docker & Docker Compose installed
- Node.js >= 18.x
- Python >= 3.11 (for local embed service, optional if using Docker)
- NPM >= 9.x

---

## Getting Started (Local)

1. Clone the repository:
```bash
git clone https://github.com/Ujjwalverma2803/rag-news-chatbot-backend.git
cd rag-news-chatbot-backend
