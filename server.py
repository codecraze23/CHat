from fastapi import FastAPI, APIRouter, HTTPException, Depends, status, WebSocket, WebSocketDisconnect, UploadFile, File, Form
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from fastapi.staticfiles import StaticFiles
from dotenv import load_dotenv
from starlette.middleware.cors import CORSMiddleware
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import uuid
from datetime import datetime, timezone, timedelta
import bcrypt
import jwt
from enum import Enum
import json
import base64
import aiofiles
import shutil


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# Create uploads directory
UPLOAD_DIR = ROOT_DIR / "uploads"
UPLOAD_DIR.mkdir(exist_ok=True)
(UPLOAD_DIR / "profiles").mkdir(exist_ok=True)
(UPLOAD_DIR / "wallpapers").mkdir(exist_ok=True)
(UPLOAD_DIR / "files").mkdir(exist_ok=True)
(UPLOAD_DIR / "voice").mkdir(exist_ok=True)

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# JWT Configuration
JWT_SECRET = os.environ.get('JWT_SECRET', 'your-secret-key-change-this')
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = 24 * 7  # 7 days

# Create the main app without a prefix
app = FastAPI(title="WhisperLink Chat API")

# Mount static files for uploads
app.mount("/uploads", StaticFiles(directory=str(UPLOAD_DIR)), name="uploads")

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# WebSocket connection manager with online status
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.user_status: Dict[str, datetime] = {}
    
    async def connect(self, websocket: WebSocket, user_id: str):
        await websocket.accept()
        self.active_connections[user_id] = websocket
        self.user_status[user_id] = datetime.now(timezone.utc)
        
        # Notify others about online status
        await self.broadcast_user_status(user_id, True)
        
    def disconnect(self, user_id: str):
        if user_id in self.active_connections:
            del self.active_connections[user_id]
        if user_id in self.user_status:
            del self.user_status[user_id]
    
    def is_user_online(self, user_id: str) -> bool:
        return user_id in self.active_connections
    
    def get_last_seen(self, user_id: str) -> Optional[datetime]:
        return self.user_status.get(user_id)
    
    async def send_personal_message(self, message: str, user_id: str):
        if user_id in self.active_connections:
            try:
                await self.active_connections[user_id].send_text(message)
                return True
            except Exception:
                self.disconnect(user_id)
                return False
        return False
    
    async def broadcast_user_status(self, user_id: str, is_online: bool):
        status_message = json.dumps({
            "type": "user_status",
            "user_id": user_id,
            "is_online": is_online,
            "last_seen": datetime.now(timezone.utc).isoformat()
        })
        
        # Send to all connected users
        for connected_user_id in list(self.active_connections.keys()):
            if connected_user_id != user_id:
                await self.send_personal_message(status_message, connected_user_id)

manager = ConnectionManager()

# Models
class AccountType(str, Enum):
    PUBLIC = "public"
    SECRET = "secret"

class MessageType(str, Enum):
    TEXT = "text"
    IMAGE = "image"
    FILE = "file"
    VOICE = "voice"

class User(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    username: str
    display_name: str
    profile_picture: Optional[str] = None
    account_type: AccountType
    secret_partner_id: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_seen: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    theme: str = "auto"  # light, dark, auto
    is_online: bool = False

class UserCreate(BaseModel):
    username: str
    password: str
    display_name: str
    account_type: AccountType
    secret_partner_username: Optional[str] = None

class UserLogin(BaseModel):
    username: str
    password: str

class Message(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    sender_id: str
    receiver_id: str
    content: str
    message_type: MessageType = MessageType.TEXT
    file_url: Optional[str] = None
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    voice_duration: Optional[float] = None
    encrypted: bool = False
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    delivered: bool = False
    read: bool = False
    read_at: Optional[datetime] = None
    reactions: Dict[str, str] = Field(default_factory=dict)  # user_id: emoji

class MessageCreate(BaseModel):
    receiver_id: str
    content: str
    message_type: MessageType = MessageType.TEXT
    file_url: Optional[str] = None
    file_name: Optional[str] = None
    file_size: Optional[int] = None
    voice_duration: Optional[float] = None

class Reaction(BaseModel):
    message_id: str
    emoji: str

class Chat(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    participants: List[str]
    is_secret_room: bool = False
    wallpaper: Optional[str] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    last_message_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

class Nickname(BaseModel):
    chat_id: str
    user_id: str
    nickname: str
    set_by: str  # who set this nickname

class Profile(BaseModel):
    display_name: Optional[str] = None
    profile_picture: Optional[str] = None
    theme: Optional[str] = None

class WallpaperSet(BaseModel):
    chat_id: str
    wallpaper_url: str

# Security
security = HTTPBearer()

def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')

def verify_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode('utf-8'), hashed.encode('utf-8'))

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(hours=JWT_EXPIRATION_HOURS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return encoded_jwt

async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)):
    try:
        payload = jwt.decode(credentials.credentials, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        user_id: str = payload.get("sub")
        if user_id is None:
            raise HTTPException(status_code=401, detail="Invalid token")
        
        user = await db.users.find_one({"id": user_id})
        if user is None:
            raise HTTPException(status_code=401, detail="User not found")
        
        # Update online status
        user['is_online'] = manager.is_user_online(user_id)
        
        return User(**user)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Invalid token")

# Helper functions
def prepare_for_mongo(data):
    if isinstance(data, dict):
        result = {}
        for key, value in data.items():
            if isinstance(value, datetime):
                result[key] = value.isoformat()
            elif isinstance(value, dict):
                result[key] = prepare_for_mongo(value)
            elif isinstance(value, list):
                result[key] = [prepare_for_mongo(item) if isinstance(item, (dict, datetime)) else item for item in value]
            else:
                result[key] = value
        return result
    elif isinstance(data, datetime):
        return data.isoformat()
    return data

def parse_from_mongo(item):
    if isinstance(item, dict):
        result = {}
        for key, value in item.items():
            if key.endswith('_at') or key in ['timestamp', 'last_seen', 'created_at', 'last_message_at', 'read_at']:
                if isinstance(value, str):
                    try:
                        result[key] = datetime.fromisoformat(value.replace('Z', '+00:00'))
                    except:
                        result[key] = value
                else:
                    result[key] = value
            elif isinstance(value, dict):
                result[key] = parse_from_mongo(value)
            elif isinstance(value, list):
                result[key] = [parse_from_mongo(item) if isinstance(item, dict) else item for item in value]
            else:
                result[key] = value
        return result
    return item

# File upload helper
async def save_uploaded_file(file: UploadFile, subfolder: str) -> str:
    file_extension = file.filename.split('.')[-1] if '.' in file.filename else ''
    unique_filename = f"{uuid.uuid4()}.{file_extension}"
    file_path = UPLOAD_DIR / subfolder / unique_filename
    
    async with aiofiles.open(file_path, 'wb') as f:
        content = await file.read()
        await f.write(content)
    
    return f"/uploads/{subfolder}/{unique_filename}"

# Authentication Routes
@api_router.post("/auth/signup")
async def signup(user_data: UserCreate):
    # Check if username exists
    existing_user = await db.users.find_one({"username": user_data.username})
    if existing_user:
        raise HTTPException(status_code=400, detail="Username already exists")
    
    # Handle secret room accounts
    secret_partner = None
    if user_data.account_type == AccountType.SECRET:
        if not user_data.secret_partner_username:
            raise HTTPException(status_code=400, detail="Secret partner username required for secret accounts")
        
        # Check if partner exists
        secret_partner = await db.users.find_one({"username": user_data.secret_partner_username})
        if not secret_partner:
            raise HTTPException(status_code=400, detail="Secret partner not found")
        
        # Allow linking with any existing user (they don't need to be secret account type yet)
        # The partner can be either public or secret account type
    
    # Create user
    user = User(
        username=user_data.username,
        display_name=user_data.display_name,
        account_type=user_data.account_type,
        secret_partner_id=secret_partner.get('id') if secret_partner else None
    )
    
    user_dict = prepare_for_mongo(user.dict())
    user_dict['password'] = hash_password(user_data.password)
    
    await db.users.insert_one(user_dict)
    
    # Update secret partner if needed
    if secret_partner:
        # Update partner's account to be secret type and link them
        await db.users.update_one(
            {"id": secret_partner['id']},
            {"$set": {"secret_partner_id": user.id, "account_type": AccountType.SECRET}}
        )
        
        # Create secret room chat
        chat = Chat(
            participants=[user.id, secret_partner['id']],
            is_secret_room=True
        )
        await db.chats.insert_one(prepare_for_mongo(chat.dict()))
    
    # Create access token
    access_token = create_access_token(data={"sub": user.id})
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user
    }

@api_router.post("/auth/login")
async def login(login_data: UserLogin):
    user = await db.users.find_one({"username": login_data.username})
    if not user or not verify_password(login_data.password, user['password']):
        raise HTTPException(status_code=401, detail="Invalid username or password")
    
    # Update last seen
    await db.users.update_one(
        {"id": user['id']},
        {"$set": {"last_seen": datetime.now(timezone.utc).isoformat()}}
    )
    
    access_token = create_access_token(data={"sub": user['id']})
    user_obj = User(**parse_from_mongo(user))
    user_obj.is_online = manager.is_user_online(user['id'])
    
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "user": user_obj
    }

# File Upload Routes
@api_router.post("/upload/profile-picture")
async def upload_profile_picture(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user)
):
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="File must be an image")
    
    file_url = await save_uploaded_file(file, "profiles")
    
    # Update user profile picture
    await db.users.update_one(
        {"id": current_user.id},
        {"$set": {"profile_picture": file_url}}
    )
    
    return {"profile_picture_url": file_url}

@api_router.post("/upload/wallpaper")
async def upload_wallpaper(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user)
):
    if not file.content_type.startswith('image/'):
        raise HTTPException(status_code=400, detail="File must be an image")
    
    file_url = await save_uploaded_file(file, "wallpapers")
    return {"wallpaper_url": file_url}

@api_router.post("/upload/file")
async def upload_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user)
):
    file_url = await save_uploaded_file(file, "files")
    
    return {
        "file_url": file_url,
        "file_name": file.filename,
        "file_size": file.size,
        "content_type": file.content_type
    }

@api_router.post("/upload/voice")
async def upload_voice(
    file: UploadFile = File(...),
    duration: float = Form(...),
    current_user: User = Depends(get_current_user)
):
    if not file.content_type.startswith('audio/'):
        raise HTTPException(status_code=400, detail="File must be an audio file")
    
    file_url = await save_uploaded_file(file, "voice")
    
    return {
        "file_url": file_url,
        "file_name": file.filename,
        "file_size": file.size,
        "voice_duration": duration
    }

# User Routes
@api_router.get("/users/me", response_model=User)
async def get_me(current_user: User = Depends(get_current_user)):
    return current_user

@api_router.put("/users/me")
async def update_profile(profile: Profile, current_user: User = Depends(get_current_user)):
    update_data = {}
    if profile.display_name:
        update_data["display_name"] = profile.display_name
    if profile.profile_picture:
        update_data["profile_picture"] = profile.profile_picture
    if profile.theme:
        update_data["theme"] = profile.theme
    
    if update_data:
        await db.users.update_one(
            {"id": current_user.id},
            {"$set": update_data}
        )
    
    return {"message": "Profile updated successfully"}

@api_router.get("/users/search")
async def search_users(q: str, current_user: User = Depends(get_current_user)):
    # Only show public accounts in search
    if current_user.account_type == AccountType.SECRET:
        return []
    
    users = await db.users.find({
        "username": {"$regex": q, "$options": "i"},
        "account_type": AccountType.PUBLIC,
        "id": {"$ne": current_user.id}
    }).to_list(20)
    
    result = []
    for user in users:
        user_data = {
            "id": user['id'],
            "username": user['username'],
            "display_name": user['display_name'],
            "profile_picture": user.get('profile_picture'),
            "is_online": manager.is_user_online(user['id']),
            "last_seen": user.get('last_seen')
        }
        result.append(user_data)
    
    return result

# Chat Routes
@api_router.get("/chats")
async def get_chats(current_user: User = Depends(get_current_user)):
    chats = await db.chats.find({
        "participants": current_user.id
    }).sort("last_message_at", -1).to_list(50)
    
    chat_list = []
    for chat in chats:
        chat_parsed = parse_from_mongo(chat)
        
        # Get other participant info
        other_participant_id = next((p for p in chat['participants'] if p != current_user.id), None)
        if other_participant_id:
            other_user = await db.users.find_one({"id": other_participant_id})
            if other_user:
                # Get nickname for this chat
                nickname_doc = await db.nicknames.find_one({
                    "chat_id": chat_parsed['id'],
                    "user_id": other_participant_id
                })
                
                display_name = nickname_doc['nickname'] if nickname_doc else other_user['display_name']
                
                # Get last message
                last_message = await db.messages.find_one({
                    "$or": [
                        {"sender_id": current_user.id, "receiver_id": other_participant_id},
                        {"sender_id": other_participant_id, "receiver_id": current_user.id}
                    ]
                }, sort=[("timestamp", -1)])
                
                chat_list.append({
                    "id": chat_parsed['id'],
                    "participant": {
                        "id": other_user['id'],
                        "username": other_user['username'],
                        "display_name": display_name,
                        "profile_picture": other_user.get('profile_picture'),
                        "last_seen": other_user.get('last_seen'),
                        "is_online": manager.is_user_online(other_user['id'])
                    },
                    "last_message": Message(**parse_from_mongo(last_message)) if last_message else None,
                    "wallpaper": chat_parsed.get('wallpaper'),
                    "is_secret_room": chat_parsed.get('is_secret_room', False)
                })
    
    return chat_list

@api_router.get("/chats/{user_id}/messages")
async def get_messages(user_id: str, skip: int = 0, limit: int = 50, current_user: User = Depends(get_current_user)):
    # Verify chat access
    other_user = await db.users.find_one({"id": user_id})
    if not other_user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Check if users can chat
    if current_user.account_type == AccountType.SECRET:
        if current_user.secret_partner_id != user_id:
            raise HTTPException(status_code=403, detail="Secret accounts can only chat with their partner")
    elif other_user.get('account_type') == AccountType.SECRET:
        if other_user.get('secret_partner_id') != current_user.id:
            raise HTTPException(status_code=403, detail="Cannot chat with secret account")
    
    messages = await db.messages.find({
        "$or": [
            {"sender_id": current_user.id, "receiver_id": user_id},
            {"sender_id": user_id, "receiver_id": current_user.id}
        ]
    }).sort("timestamp", -1).skip(skip).limit(limit).to_list(limit)
    
    # Mark messages as read
    await db.messages.update_many(
        {
            "sender_id": user_id,
            "receiver_id": current_user.id,
            "read": False
        },
        {
            "$set": {
                "read": True,
                "read_at": datetime.now(timezone.utc).isoformat()
            }
        }
    )
    
    # Send read receipt to sender
    read_receipt = json.dumps({
        "type": "read_receipt",
        "chat_user_id": current_user.id
    })
    await manager.send_personal_message(read_receipt, user_id)
    
    return [Message(**parse_from_mongo(msg)) for msg in reversed(messages)]

@api_router.post("/messages", response_model=Message)
async def send_message(message_data: MessageCreate, current_user: User = Depends(get_current_user)):
    # Verify receiver exists and chat is allowed
    receiver = await db.users.find_one({"id": message_data.receiver_id})
    if not receiver:
        raise HTTPException(status_code=404, detail="Receiver not found")
    
    # Check if users can chat
    if current_user.account_type == AccountType.SECRET:
        if current_user.secret_partner_id != message_data.receiver_id:
            raise HTTPException(status_code=403, detail="Secret accounts can only chat with their partner")
    elif receiver.get('account_type') == AccountType.SECRET:
        if receiver.get('secret_partner_id') != current_user.id:
            raise HTTPException(status_code=403, detail="Cannot chat with secret account")
    
    # Create message
    message = Message(
        sender_id=current_user.id,
        receiver_id=message_data.receiver_id,
        content=message_data.content,
        message_type=message_data.message_type,
        file_url=message_data.file_url,
        file_name=message_data.file_name,
        file_size=message_data.file_size,
        voice_duration=message_data.voice_duration,
        delivered=True
    )
    
    message_dict = prepare_for_mongo(message.dict())
    await db.messages.insert_one(message_dict)
    
    # Update or create chat
    chat = await db.chats.find_one({
        "participants": {"$all": [current_user.id, message_data.receiver_id]}
    })
    
    if not chat:
        new_chat = Chat(
            participants=[current_user.id, message_data.receiver_id],
            is_secret_room=current_user.account_type == AccountType.SECRET
        )
        await db.chats.insert_one(prepare_for_mongo(new_chat.dict()))
    else:
        await db.chats.update_one(
            {"id": chat['id']},
            {"$set": {"last_message_at": message.timestamp.isoformat()}}
        )
    
    # Send real-time message
    message_json = json.dumps({
        "type": "message",
        "data": message.dict(),
        "sender": {
            "id": current_user.id,
            "username": current_user.username,
            "display_name": current_user.display_name,
            "profile_picture": current_user.profile_picture
        }
    }, default=str)
    
    await manager.send_personal_message(message_json, message_data.receiver_id)
    
    return message

@api_router.post("/messages/{message_id}/reaction")
async def add_reaction(message_id: str, reaction: Reaction, current_user: User = Depends(get_current_user)):
    message = await db.messages.find_one({"id": message_id})
    if not message:
        raise HTTPException(status_code=404, detail="Message not found")
    
    # Check if user is part of this conversation
    if current_user.id not in [message['sender_id'], message['receiver_id']]:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    # Update reaction
    reactions = message.get('reactions', {})
    if reaction.emoji:
        reactions[current_user.id] = reaction.emoji
    else:
        reactions.pop(current_user.id, None)
    
    await db.messages.update_one(
        {"id": message_id},
        {"$set": {"reactions": reactions}}
    )
    
    # Send real-time update
    other_user_id = message['receiver_id'] if message['sender_id'] == current_user.id else message['sender_id']
    reaction_json = json.dumps({
        "type": "reaction",
        "message_id": message_id,
        "user_id": current_user.id,
        "emoji": reaction.emoji
    })
    
    await manager.send_personal_message(reaction_json, other_user_id)
    
    return {"message": "Reaction updated"}

# Nickname Routes
@api_router.post("/chats/{chat_id}/nickname")
async def set_nickname(
    chat_id: str,
    nickname_data: dict,
    current_user: User = Depends(get_current_user)
):
    chat = await db.chats.find_one({"id": chat_id})
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    
    if current_user.id not in chat['participants']:
        raise HTTPException(status_code=403, detail="Not a participant in this chat")
    
    # Get the other participant
    other_user_id = next(p for p in chat['participants'] if p != current_user.id)
    
    # Set nickname
    await db.nicknames.update_one(
        {
            "chat_id": chat_id,
            "user_id": other_user_id
        },
        {
            "$set": {
                "chat_id": chat_id,
                "user_id": other_user_id,
                "nickname": nickname_data['nickname'],
                "set_by": current_user.id
            }
        },
        upsert=True
    )
    
    return {"message": "Nickname updated"}

# Wallpaper Routes
@api_router.post("/chats/{chat_id}/wallpaper")
async def set_wallpaper(
    chat_id: str,
    wallpaper_data: WallpaperSet,
    current_user: User = Depends(get_current_user)
):
    chat = await db.chats.find_one({"id": chat_id})
    if not chat:
        raise HTTPException(status_code=404, detail="Chat not found")
    
    if current_user.id not in chat['participants']:
        raise HTTPException(status_code=403, detail="Not a participant in this chat")
    
    await db.chats.update_one(
        {"id": chat_id},
        {"$set": {"wallpaper": wallpaper_data.wallpaper_url}}
    )
    
    return {"message": "Wallpaper updated"}

# WebSocket endpoint
@app.websocket("/ws/{user_id}")
async def websocket_endpoint(websocket: WebSocket, user_id: str):
    await manager.connect(websocket, user_id)
    try:
        while True:
            data = await websocket.receive_text()
            # Handle incoming WebSocket data if needed
    except WebSocketDisconnect:
        manager.disconnect(user_id)
        await manager.broadcast_user_status(user_id, False)

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=os.environ.get('CORS_ORIGINS', '*').split(','),
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()