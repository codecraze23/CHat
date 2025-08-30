import React, { useState, useEffect, useContext, createContext, useRef, useCallback } from 'react';
import axios from 'axios';
import './App.css';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;

// Auth Context
const AuthContext = createContext(null);

const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
};

const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      fetchUser();
    } else {
      setLoading(false);
    }
  }, [token]);

  const fetchUser = async () => {
    try {
      const response = await axios.get(`${API}/users/me`);
      setUser(response.data);
    } catch (error) {
      logout();
    } finally {
      setLoading(false);
    }
  };

  const login = async (username, password) => {
    const response = await axios.post(`${API}/auth/login`, { username, password });
    const { access_token, user } = response.data;
    
    localStorage.setItem('token', access_token);
    setToken(access_token);
    setUser(user);
    axios.defaults.headers.common['Authorization'] = `Bearer ${access_token}`;
    
    return { success: true };
  };

  const signup = async (userData) => {
    const response = await axios.post(`${API}/auth/signup`, userData);
    const { access_token, user } = response.data;
    
    localStorage.setItem('token', access_token);
    setToken(access_token);
    setUser(user);
    axios.defaults.headers.common['Authorization'] = `Bearer ${access_token}`;
    
    return { success: true };
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
    delete axios.defaults.headers.common['Authorization'];
  };

  return (
    <AuthContext.Provider value={{ user, login, signup, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
};

// WebSocket Hook with enhanced features
const useWebSocket = (userId) => {
  const [socket, setSocket] = useState(null);
  const [messages, setMessages] = useState([]);
  const [isConnected, setIsConnected] = useState(false);
  const [onlineUsers, setOnlineUsers] = useState({});

  useEffect(() => {
    if (userId) {
      const wsUrl = BACKEND_URL.replace('https://', 'wss://').replace('http://', 'ws://');
      const ws = new WebSocket(`${wsUrl}/ws/${userId}`);
      
      ws.onopen = () => {
        setIsConnected(true);
        console.log('WebSocket connected');
      };
      
      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'message') {
          setMessages(prev => [...prev, data.data]);
        } else if (data.type === 'reaction') {
          setMessages(prev => 
            prev.map(msg => 
              msg.id === data.message_id 
                ? { ...msg, reactions: { ...msg.reactions, [data.user_id]: data.emoji } }
                : msg
            )
          );
        } else if (data.type === 'user_status') {
          setOnlineUsers(prev => ({
            ...prev,
            [data.user_id]: {
              is_online: data.is_online,
              last_seen: data.last_seen
            }
          }));
        } else if (data.type === 'read_receipt') {
          // Handle read receipts
          setMessages(prev =>
            prev.map(msg =>
              msg.sender_id === userId ? { ...msg, read: true } : msg
            )
          );
        }
      };
      
      ws.onclose = () => {
        setIsConnected(false);
        console.log('WebSocket disconnected');
      };
      
      setSocket(ws);
      
      return () => {
        ws.close();
      };
    }
  }, [userId]);

  return { socket, messages, setMessages, isConnected, onlineUsers };
};

// File Upload Hook
const useFileUpload = () => {
  const [uploading, setUploading] = useState(false);
  
  const uploadFile = async (file, type = 'file') => {
    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    
    if (type === 'voice') {
      formData.append('duration', file.duration || 0);
    }
    
    try {
      const response = await axios.post(`${API}/upload/${type}`, formData, {
        headers: {
          'Content-Type': 'multipart/form-data',
        },
      });
      
      return response.data;
    } catch (error) {
      throw error;
    } finally {
      setUploading(false);
    }
  };
  
  return { uploadFile, uploading };
};

// Voice Recording Hook
const useVoiceRecording = () => {
  const [isRecording, setIsRecording] = useState(false);
  const [mediaRecorder, setMediaRecorder] = useState(null);
  const [recordingBlob, setRecordingBlob] = useState(null);
  const [duration, setDuration] = useState(0);
  const startTimeRef = useRef(null);
  
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaRecorder.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      
      const chunks = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        setRecordingBlob(blob);
        setDuration(Date.now() - startTimeRef.current);
      };
      
      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
      startTimeRef.current = Date.now();
    } catch (error) {
      console.error('Error starting recording:', error);
    }
  };
  
  const stopRecording = () => {
    if (mediaRecorder) {
      mediaRecorder.stop();
      mediaRecorder.stream.getTracks().forEach(track => track.stop());
      setIsRecording(false);
    }
  };
  
  return {
    isRecording,
    recordingBlob,
    duration: duration / 1000,
    startRecording,
    stopRecording
  };
};

// Authentication Component
const AuthScreen = () => {
  const [isLogin, setIsLogin] = useState(true);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    display_name: '',
    account_type: 'public',
    secret_partner_username: ''
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, signup } = useAuth();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    
    try {
      if (isLogin) {
        await login(formData.username, formData.password);
      } else {
        await signup(formData);
      }
    } catch (error) {
      setError(error.response?.data?.detail || 'An error occurred');
    } finally {
      setLoading(false);
    }
  };

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="bg-white rounded-2xl shadow-xl p-8">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-gray-900">WhisperLink</h1>
            <p className="text-gray-600">Secure 1-to-1 Chat</p>
          </div>

          <div className="flex bg-gray-100 rounded-lg p-1 mb-6">
            <button
              type="button"
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                isLogin ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
              }`}
              onClick={() => setIsLogin(true)}
            >
              Login
            </button>
            <button
              type="button"
              className={`flex-1 py-2 px-4 rounded-md text-sm font-medium transition-colors ${
                !isLogin ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-600'
              }`}
              onClick={() => setIsLogin(false)}
            >
              Sign Up
            </button>
          </div>

          {error && (
            <div className="mb-4 p-3 bg-red-100 border border-red-300 text-red-700 rounded-lg text-sm">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                type="text"
                name="username"
                placeholder="Username"
                value={formData.username}
                onChange={handleChange}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                required
              />
            </div>

            {!isLogin && (
              <div>
                <input
                  type="text"
                  name="display_name"
                  placeholder="Display Name"
                  value={formData.display_name}
                  onChange={handleChange}
                  className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                  required
                />
              </div>
            )}

            <div>
              <input
                type="password"
                name="password"
                placeholder="Password"
                value={formData.password}
                onChange={handleChange}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                required
              />
            </div>

            {!isLogin && (
              <>
                <div>
                  <select
                    name="account_type"
                    value={formData.account_type}
                    onChange={handleChange}
                    className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                  >
                    <option value="public">Public Account</option>
                    <option value="secret">Secret Room Account</option>
                  </select>
                </div>

                {formData.account_type === 'secret' && (
                  <div>
                    <input
                      type="text"
                      name="secret_partner_username"
                      placeholder="Partner's Username"
                      value={formData.secret_partner_username}
                      onChange={handleChange}
                      className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none transition-all"
                      required
                    />
                  </div>
                )}
              </>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-gradient-to-r from-blue-500 to-purple-600 text-white py-3 px-4 rounded-lg font-medium hover:from-blue-600 hover:to-purple-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              {loading ? (
                <div className="flex items-center justify-center">
                  <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin mr-2"></div>
                  Processing...
                </div>
              ) : (
                isLogin ? 'Login' : 'Create Account'
              )}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};

// Profile Modal Component
const ProfileModal = ({ isOpen, onClose, user }) => {
  const [formData, setFormData] = useState({
    display_name: user?.display_name || '',
    theme: user?.theme || 'auto'
  });
  const [profileFile, setProfileFile] = useState(null);
  const [profilePreview, setProfilePreview] = useState(user?.profile_picture || null);
  const { uploadFile, uploading } = useFileUpload();

  const handleProfilePictureChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setProfileFile(file);
      const reader = new FileReader();
      reader.onload = (e) => setProfilePreview(e.target.result);
      reader.readAsDataURL(file);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    try {
      let profilePictureUrl = profilePreview;
      
      if (profileFile) {
        const uploadResult = await uploadFile(profileFile, 'profile-picture');
        profilePictureUrl = `${BACKEND_URL}${uploadResult.profile_picture_url}`;
      }
      
      await axios.put(`${API}/users/me`, {
        ...formData,
        profile_picture: profilePictureUrl
      });
      
      onClose();
      window.location.reload(); // Refresh to update profile
    } catch (error) {
      console.error('Error updating profile:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Edit Profile</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl"
          >
            ×
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="flex flex-col items-center mb-6">
            <div className="w-20 h-20 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white font-medium text-xl mb-4 overflow-hidden">
              {profilePreview ? (
                <img src={profilePreview} alt="Profile" className="w-full h-full object-cover" />
              ) : (
                user?.display_name?.charAt(0)?.toUpperCase()
              )}
            </div>
            
            <label className="cursor-pointer bg-blue-500 text-white px-4 py-2 rounded-lg text-sm hover:bg-blue-600 transition-colors">
              Change Photo
              <input
                type="file"
                accept="image/*"
                onChange={handleProfilePictureChange}
                className="hidden"
              />
            </label>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Display Name</label>
            <input
              type="text"
              value={formData.display_name}
              onChange={(e) => setFormData({ ...formData, display_name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Theme</label>
            <select
              value={formData.theme}
              onChange={(e) => setFormData({ ...formData, theme: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="auto">Auto</option>
            </select>
          </div>
          
          <div className="flex space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={uploading}
              className="flex-1 py-2 px-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50"
            >
              {uploading ? 'Saving...' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Wallpaper Modal Component
const WallpaperModal = ({ isOpen, onClose, chatId, currentWallpaper }) => {
  const [wallpaperFile, setWallpaperFile] = useState(null);
  const [wallpaperPreview, setWallpaperPreview] = useState(currentWallpaper);
  const { uploadFile, uploading } = useFileUpload();

  const predefinedWallpapers = [
    '/api/static/wallpapers/gradient1.jpg',
    '/api/static/wallpapers/gradient2.jpg',
    '/api/static/wallpapers/pattern1.jpg',
    null // No wallpaper option
  ];

  const handleWallpaperChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      setWallpaperFile(file);
      const reader = new FileReader();
      reader.onload = (e) => setWallpaperPreview(e.target.result);
      reader.readAsDataURL(file);
    }
  };

  const setWallpaper = async (wallpaperUrl) => {
    try {
      await axios.post(`${API}/chats/${chatId}/wallpaper`, {
        chat_id: chatId,
        wallpaper_url: wallpaperUrl
      });
      onClose();
    } catch (error) {
      console.error('Error setting wallpaper:', error);
    }
  };

  const handleCustomWallpaper = async () => {
    if (wallpaperFile) {
      try {
        const uploadResult = await uploadFile(wallpaperFile, 'wallpaper');
        const wallpaperUrl = `${BACKEND_URL}${uploadResult.wallpaper_url}`;
        await setWallpaper(wallpaperUrl);
      } catch (error) {
        console.error('Error uploading wallpaper:', error);
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Chat Wallpaper</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl"
          >
            ×
          </button>
        </div>
        
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {predefinedWallpapers.map((wallpaper, index) => (
              <button
                key={index}
                onClick={() => setWallpaper(wallpaper)}
                className="h-20 rounded-lg border-2 border-gray-300 hover:border-blue-500 transition-colors overflow-hidden"
                style={{
                  backgroundImage: wallpaper ? `url(${wallpaper})` : 'none',
                  backgroundColor: wallpaper ? 'transparent' : '#f3f4f6',
                  backgroundSize: 'cover',
                  backgroundPosition: 'center'
                }}
              >
                {!wallpaper && (
                  <span className="text-gray-500 text-sm">No Wallpaper</span>
                )}
              </button>
            ))}
          </div>
          
          <div className="border-t pt-4">
            <label className="cursor-pointer flex items-center justify-center bg-blue-500 text-white px-4 py-3 rounded-lg hover:bg-blue-600 transition-colors">
              📁 Upload Custom Wallpaper
              <input
                type="file"
                accept="image/*"
                onChange={handleWallpaperChange}
                className="hidden"
              />
            </label>
            
            {wallpaperPreview && wallpaperFile && (
              <div className="mt-4">
                <div className="h-20 rounded-lg overflow-hidden mb-2">
                  <img src={wallpaperPreview} alt="Preview" className="w-full h-full object-cover" />
                </div>
                <button
                  onClick={handleCustomWallpaper}
                  disabled={uploading}
                  className="w-full py-2 bg-green-500 text-white rounded-lg hover:bg-green-600 disabled:opacity-50"
                >
                  {uploading ? 'Setting...' : 'Set This Wallpaper'}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// Nickname Modal Component
const NicknameModal = ({ isOpen, onClose, chatId, currentNickname, partnerName }) => {
  const [nickname, setNickname] = useState(currentNickname || '');

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      await axios.post(`${API}/chats/${chatId}/nickname`, {
        nickname: nickname || partnerName
      });
      onClose();
    } catch (error) {
      console.error('Error setting nickname:', error);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl p-6 w-full max-w-md">
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-xl font-bold">Set Nickname</h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-700 text-2xl"
          >
            ×
          </button>
        </div>
        
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Nickname for {partnerName}
            </label>
            <input
              type="text"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              placeholder={partnerName}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
          
          <div className="flex space-x-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 px-4 border border-gray-300 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="flex-1 py-2 px-4 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// Chat List Component
const ChatList = ({ onSelectChat, selectedChatId, onlineUsers }) => {
  const [chats, setChats] = useState([]);
  const [loading, setLoading] = useState(true);
  const { user } = useAuth();

  useEffect(() => {
    fetchChats();
  }, []);

  const fetchChats = async () => {
    try {
      const response = await axios.get(`${API}/chats`);
      setChats(response.data);
    } catch (error) {
      console.error('Failed to fetch chats:', error);
    } finally {
      setLoading(false);
    }
  };

  const formatTime = (timestamp) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = diff / (1000 * 60 * 60);
    
    if (hours < 24) {
      return date.toLocaleTimeString('en-US', { 
        hour: 'numeric', 
        minute: '2-digit', 
        hour12: true 
      });
    } else {
      return date.toLocaleDateString('en-US', { 
        month: 'short', 
        day: 'numeric' 
      });
    }
  };

  const isUserOnline = (userId) => {
    return onlineUsers[userId]?.is_online || false;
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {chats.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-gray-500 p-8">
          <svg className="w-12 h-12 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <p className="text-center">No chats yet<br />Start a conversation!</p>
        </div>
      ) : (
        chats.map((chat) => (
          <div
            key={chat.id}
            onClick={() => onSelectChat(chat)}
            className={`flex items-center p-4 hover:bg-gray-50 cursor-pointer border-b border-gray-100 transition-colors ${
              selectedChatId === chat.id ? 'bg-blue-50 border-r-2 border-r-blue-500' : ''
            }`}
          >
            <div className="relative mr-3 flex-shrink-0">
              <div className="w-12 h-12 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white font-medium text-sm overflow-hidden">
                {chat.participant.profile_picture ? (
                  <img 
                    src={chat.participant.profile_picture} 
                    alt={chat.participant.display_name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  chat.participant.display_name.charAt(0).toUpperCase()
                )}
              </div>
              {isUserOnline(chat.participant.id) && (
                <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 rounded-full border-2 border-white"></div>
              )}
            </div>
            
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1">
                <h3 className="font-medium text-gray-900 truncate">
                  {chat.participant.display_name}
                  {chat.is_secret_room && (
                    <span className="ml-2 text-xs bg-purple-100 text-purple-600 px-2 py-0.5 rounded-full">
                      Secret
                    </span>
                  )}
                </h3>
                {chat.last_message && (
                  <span className="text-xs text-gray-500 flex-shrink-0">
                    {formatTime(chat.last_message.timestamp)}
                  </span>
                )}
              </div>
              
              {chat.last_message && (
                <div className="flex items-center">
                  <p className="text-sm text-gray-600 truncate flex-1">
                    {chat.last_message.message_type === 'text' ? 
                      chat.last_message.content : 
                      chat.last_message.message_type === 'image' ? '📷 Image' :
                      chat.last_message.message_type === 'voice' ? '🎤 Voice message' :
                      `📎 ${chat.last_message.message_type}`
                    }
                  </p>
                  {chat.last_message.sender_id === user?.id && (
                    <div className="flex text-xs ml-2">
                      <span className={`${chat.last_message.delivered ? 'text-blue-500' : 'text-gray-400'}`}>
                        ✓
                      </span>
                      {chat.last_message.read && (
                        <span className="text-blue-500 -ml-1">✓</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
};

// Enhanced Message Component
const MessageBubble = ({ message, isOwn, onReaction, onlineUsers, chat }) => {
  const [showReactions, setShowReactions] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);
  const reactions = ['❤️', '😂', '👍', '👎', '😮', '😢', '😡'];

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('en-US', { 
      hour: 'numeric', 
      minute: '2-digit', 
      hour12: true 
    });
  };

  const handleReactionClick = (emoji) => {
    onReaction(message.id, emoji);
    setShowReactions(false);
  };

  const renderMessageContent = () => {
    switch (message.message_type) {
      case 'image':
        return (
          <div>
            {!imageLoaded && (
              <div className="w-48 h-32 bg-gray-200 rounded-lg flex items-center justify-center">
                <div className="w-6 h-6 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
            <img 
              src={message.file_url} 
              alt="Shared image"
              className={`rounded-lg max-w-48 h-auto ${imageLoaded ? 'block' : 'hidden'}`}
              onLoad={() => setImageLoaded(true)}
              onClick={() => {
                // Open image in lightbox
                window.open(message.file_url, '_blank');
              }}
            />
            {message.content && <p className="mt-2 break-words">{message.content}</p>}
          </div>
        );
      
      case 'voice':
        return (
          <div className="flex items-center space-x-3">
            <button className="w-8 h-8 bg-blue-500 text-white rounded-full flex items-center justify-center">
              ▶️
            </button>
            <div className="flex-1">
              <div className="h-1 bg-gray-300 rounded-full">
                <div className="h-1 bg-blue-500 rounded-full w-0"></div>
              </div>
              <span className="text-xs text-gray-500">{message.voice_duration}s</span>
            </div>
          </div>
        );
      
      case 'file':
        return (
          <div className="flex items-center space-x-3 p-3 bg-gray-50 rounded-lg">
            <div className="w-10 h-10 bg-gray-300 rounded flex items-center justify-center">
              📎
            </div>
            <div className="flex-1">
              <p className="font-medium text-sm">{message.file_name}</p>
              <p className="text-xs text-gray-500">{(message.file_size / 1024).toFixed(1)} KB</p>
            </div>
            <a 
              href={message.file_url} 
              download={message.file_name}
              className="text-blue-500 hover:text-blue-700"
            >
              ⬇️
            </a>
          </div>
        );
      
      default:
        return <p className="break-words">{message.content}</p>;
    }
  };

  return (
    <div className={`flex ${isOwn ? 'justify-end' : 'justify-start'} mb-4 group`}>
      <div className={`max-w-xs lg:max-w-md relative ${isOwn ? 'order-2' : 'order-1'}`}>
        <div
          className={`px-4 py-2 rounded-2xl ${
            isOwn
              ? 'bg-blue-500 text-white rounded-br-md'
              : 'bg-gray-100 text-gray-900 rounded-bl-md'
          } shadow-sm`}
          onContextMenu={(e) => {
            e.preventDefault();
            setShowReactions(true);
          }}
          style={chat?.wallpaper ? {
            backgroundImage: `url(${chat.wallpaper})`,
            backgroundSize: 'cover',
            backgroundBlendMode: 'overlay',
            backgroundColor: isOwn ? 'rgba(59, 130, 246, 0.8)' : 'rgba(243, 244, 246, 0.8)'
          } : {}}
        >
          {renderMessageContent()}
          
          <div className="flex items-center justify-between mt-1">
            <span className={`text-xs ${isOwn ? 'text-blue-100' : 'text-gray-500'}`}>
              {formatTime(message.timestamp)}
            </span>
            
            {isOwn && (
              <div className="flex text-xs ml-2">
                <span className={`${message.delivered ? 'text-blue-200' : 'text-blue-300'}`}>
                  ✓
                </span>
                {message.read && (
                  <span className="text-blue-200 -ml-1">✓</span>
                )}
              </div>
            )}
          </div>
        </div>
        
        {/* Reactions */}
        {Object.keys(message.reactions || {}).length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1">
            {Object.entries(message.reactions).map(([userId, emoji]) => (
              <span key={userId} className="text-sm bg-white rounded-full px-2 py-1 shadow-sm border">
                {emoji}
              </span>
            ))}
          </div>
        )}
        
        {/* Reaction Picker */}
        {showReactions && (
          <div className="absolute top-0 left-0 right-0 bg-white rounded-lg shadow-lg border p-2 z-10 flex flex-wrap gap-2">
            {reactions.map((emoji) => (
              <button
                key={emoji}
                onClick={() => handleReactionClick(emoji)}
                className="text-lg hover:bg-gray-100 rounded p-1 transition-colors"
              >
                {emoji}
              </button>
            ))}
            <button
              onClick={() => setShowReactions(false)}
              className="text-sm text-gray-500 hover:text-gray-700 ml-auto"
            >
              ✕
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// Enhanced Chat Screen Component
const ChatScreen = ({ chat, onlineUsers }) => {
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showWallpaperModal, setShowWallpaperModal] = useState(false);
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const { user } = useAuth();
  const { messages: wsMessages, setMessages: setWsMessages } = useWebSocket(user?.id);
  const { uploadFile, uploading: fileUploading } = useFileUpload();
  const { isRecording, recordingBlob, duration, startRecording, stopRecording } = useVoiceRecording();

  useEffect(() => {
    if (chat) {
      fetchMessages();
    }
  }, [chat]);

  useEffect(() => {
    // Handle incoming WebSocket messages
    const newWsMessages = wsMessages.filter(msg => 
      (msg.sender_id === chat?.participant.id && msg.receiver_id === user?.id) ||
      (msg.sender_id === user?.id && msg.receiver_id === chat?.participant.id)
    );
    
    if (newWsMessages.length > 0) {
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const uniqueNew = newWsMessages.filter(m => !existingIds.has(m.id));
        return [...prev, ...uniqueNew];
      });
      setWsMessages([]);
    }
  }, [wsMessages, chat, user]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    if (recordingBlob) {
      handleVoiceMessage();
    }
  }, [recordingBlob]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchMessages = async () => {
    if (!chat) return;
    
    setLoading(true);
    try {
      const response = await axios.get(`${API}/chats/${chat.participant.id}/messages`);
      setMessages(response.data);
    } catch (error) {
      console.error('Failed to fetch messages:', error);
    } finally {
      setLoading(false);
    }
  };

  const sendMessage = async (e) => {
    e.preventDefault();
    if (!newMessage.trim() || sending) return;

    setSending(true);
    try {
      const response = await axios.post(`${API}/messages`, {
        receiver_id: chat.participant.id,
        content: newMessage.trim(),
        message_type: 'text'
      });
      
      setMessages(prev => [...prev, response.data]);
      setNewMessage('');
    } catch (error) {
      console.error('Failed to send message:', error);
    } finally {
      setSending(false);
    }
  };

  const handleFileUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    try {
      const isImage = file.type.startsWith('image/');
      const uploadResult = await uploadFile(file, isImage ? 'file' : 'file');
      const fileUrl = `${BACKEND_URL}${uploadResult.file_url}`;
      
      const response = await axios.post(`${API}/messages`, {
        receiver_id: chat.participant.id,
        content: '',
        message_type: isImage ? 'image' : 'file',
        file_url: fileUrl,
        file_name: uploadResult.file_name,
        file_size: uploadResult.file_size
      });
      
      setMessages(prev => [...prev, response.data]);
    } catch (error) {
      console.error('Failed to upload file:', error);
    }
  };

  const handleVoiceMessage = async () => {
    if (!recordingBlob) return;

    try {
      const file = new File([recordingBlob], 'voice.webm', { type: 'audio/webm' });
      file.duration = duration;
      
      const uploadResult = await uploadFile(file, 'voice');
      const fileUrl = `${BACKEND_URL}${uploadResult.file_url}`;
      
      const response = await axios.post(`${API}/messages`, {
        receiver_id: chat.participant.id,
        content: '',
        message_type: 'voice',
        file_url: fileUrl,
        file_name: uploadResult.file_name,
        voice_duration: uploadResult.voice_duration
      });
      
      setMessages(prev => [...prev, response.data]);
    } catch (error) {
      console.error('Failed to send voice message:', error);
    }
  };

  const handleReaction = async (messageId, emoji) => {
    try {
      await axios.post(`${API}/messages/${messageId}/reaction`, { 
        message_id: messageId,
        emoji 
      });
      
      setMessages(prev => 
        prev.map(msg => 
          msg.id === messageId 
            ? { ...msg, reactions: { ...msg.reactions, [user.id]: emoji } }
            : msg
        )
      );
    } catch (error) {
      console.error('Failed to add reaction:', error);
    }
  };

  const isUserOnline = (userId) => {
    return onlineUsers[userId]?.is_online || false;
  };

  if (!chat) {
    return (
      <div className="flex-1 flex items-center justify-center bg-gray-50">
        <div className="text-center text-gray-500">
          <svg className="w-16 h-16 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <h3 className="text-lg font-medium mb-2">Welcome to WhisperLink</h3>
          <p>Select a chat to start messaging</p>
        </div>
      </div>
    );
  }

  return (
    <div 
      className="flex-1 flex flex-col bg-white"
      style={chat.wallpaper ? {
        backgroundImage: `url(${chat.wallpaper})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center'
      } : {}}
    >
      {/* Chat Header */}
      <div className="flex items-center justify-between p-4 border-b border-gray-200 bg-white bg-opacity-95 backdrop-blur-sm">
        <div className="flex items-center">
          <div className="relative mr-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white font-medium text-sm overflow-hidden">
              {chat.participant.profile_picture ? (
                <img 
                  src={chat.participant.profile_picture} 
                  alt={chat.participant.display_name}
                  className="w-full h-full object-cover"
                />
              ) : (
                chat.participant.display_name.charAt(0).toUpperCase()
              )}
            </div>
            {isUserOnline(chat.participant.id) && (
              <div className="absolute -bottom-1 -right-1 w-3 h-3 bg-green-500 rounded-full border-2 border-white"></div>
            )}
          </div>
          <div>
            <h2 className="font-medium text-gray-900">{chat.participant.display_name}</h2>
            <p className="text-sm text-gray-500">
              {isUserOnline(chat.participant.id) ? 'Online' : `@${chat.participant.username}`}
            </p>
          </div>
        </div>
        
        <div className="flex items-center space-x-2">
          {chat.is_secret_room && (
            <span className="text-xs bg-purple-100 text-purple-600 px-2 py-1 rounded-full">
              Secret Room
            </span>
          )}
          
          <div className="relative group">
            <button className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors">
              ⋯
            </button>
            <div className="absolute right-0 top-full mt-1 bg-white rounded-lg shadow-lg border py-1 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10 min-w-48">
              <button
                onClick={() => setShowNicknameModal(true)}
                className="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors"
              >
                Set Nickname
              </button>
              <button
                onClick={() => setShowWallpaperModal(true)}
                className="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors"
              >
                Change Wallpaper
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-500">
            <div className="text-center">
              <svg className="w-12 h-12 mx-auto mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <p>No messages yet<br />Say hello! 👋</p>
            </div>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                isOwn={message.sender_id === user.id}
                onReaction={handleReaction}
                onlineUsers={onlineUsers}
                chat={chat}
              />
            ))}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Message Input */}
      <div className="p-4 border-t border-gray-200 bg-white bg-opacity-95 backdrop-blur-sm">
        <form onSubmit={sendMessage} className="flex items-center space-x-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="w-10 h-10 text-gray-500 hover:text-gray-700 rounded-full hover:bg-gray-100 flex items-center justify-center transition-colors"
          >
            📎
          </button>
          
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileUpload}
            className="hidden"
            multiple
          />
          
          <div className="flex-1 relative">
            <input
              type="text"
              value={newMessage}
              onChange={(e) => setNewMessage(e.target.value)}
              placeholder="Type a message..."
              className="w-full px-4 py-3 border border-gray-300 rounded-full focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none pr-12 transition-all"
              disabled={sending || fileUploading}
            />
          </div>
          
          <button
            type="button"
            onMouseDown={startRecording}
            onMouseUp={stopRecording}
            onTouchStart={startRecording}
            onTouchEnd={stopRecording}
            className={`w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
              isRecording ? 'bg-red-500 text-white' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
            }`}
          >
            🎤
          </button>
          
          <button
            type="submit"
            disabled={!newMessage.trim() || sending || fileUploading}
            className="w-12 h-12 bg-blue-500 text-white rounded-full flex items-center justify-center hover:bg-blue-600 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          >
            {sending || fileUploading ? (
              <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            )}
          </button>
        </form>
      </div>
      
      {/* Modals */}
      <WallpaperModal 
        isOpen={showWallpaperModal}
        onClose={() => setShowWallpaperModal(false)}
        chatId={chat.id}
        currentWallpaper={chat.wallpaper}
      />
      
      <NicknameModal 
        isOpen={showNicknameModal}
        onClose={() => setShowNicknameModal(false)}
        chatId={chat.id}
        currentNickname={chat.participant.display_name}
        partnerName={chat.participant.display_name}
      />
    </div>
  );
};

// Main App Component
const MainApp = () => {
  const [selectedChat, setSelectedChat] = useState(null);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const { user, logout } = useAuth();
  const { onlineUsers, isConnected } = useWebSocket(user?.id);

  return (
    <div className="h-screen flex bg-gray-100">
      {/* Connection Status */}
      {isConnected && (
        <div className="fixed top-4 right-4 bg-green-500 text-white px-3 py-1 rounded-full text-sm z-50">
          🟢 Online
        </div>
      )}
      
      {/* Sidebar */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        {/* Header */}
        <div className="p-4 border-b border-gray-200">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center">
              <div className="w-8 h-8 bg-gradient-to-r from-blue-500 to-purple-600 rounded-full flex items-center justify-center mr-3">
                <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
              </div>
              <h1 className="text-xl font-bold text-gray-900">WhisperLink</h1>
            </div>
            
            <button
              onClick={logout}
              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100 transition-colors"
              title="Logout"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
            </button>
          </div>
          
          <div 
            onClick={() => setShowProfileModal(true)}
            className="flex items-center p-3 bg-gray-50 rounded-lg cursor-pointer hover:bg-gray-100 transition-colors"
          >
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-blue-400 to-purple-500 flex items-center justify-center text-white font-medium mr-3 overflow-hidden">
              {user?.profile_picture ? (
                <img 
                  src={user.profile_picture} 
                  alt={user.display_name}
                  className="w-full h-full object-cover"
                />
              ) : (
                user?.display_name?.charAt(0)?.toUpperCase() || 'U'
              )}
            </div>
            <div className="flex-1">
              <p className="font-medium text-gray-900">{user?.display_name}</p>
              <p className="text-sm text-gray-500">@{user?.username}</p>
            </div>
            <div className="text-gray-400">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </div>
          </div>
        </div>

        {/* Chat List */}
        <ChatList 
          onSelectChat={setSelectedChat} 
          selectedChatId={selectedChat?.id}
          onlineUsers={onlineUsers}
        />
      </div>

      {/* Main Chat Area */}
      <ChatScreen 
        chat={selectedChat}
        onlineUsers={onlineUsers}
      />
      
      {/* Profile Modal */}
      <ProfileModal 
        isOpen={showProfileModal}
        onClose={() => setShowProfileModal(false)}
        user={user}
      />
    </div>
  );
};

const App = () => {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-gray-600">Loading WhisperLink...</p>
        </div>
      </div>
    );
  }

  return user ? <MainApp /> : <AuthScreen />;
};

export default function AppWithAuth() {
  return (
    <AuthProvider>
      <App />
    </AuthProvider>
  );
}