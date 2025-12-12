if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ========== RATE LIMITING & CACHING ==========

// In-memory caches
const artistCache = new Map(); // Cache artist data for 1 hour
const ARTIST_CACHE_TTL = 60 * 60 * 1000; // 1 hour

// Rate limiting: Track requests per IP
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_MINUTE = 10; // Max 10 playlist analyses per minute per IP

// Global processing queue - only one playlist at a time
let isProcessing = false;
const processingQueue = [];

// Spotify timeout tracking (when we hit severe rate limits)
let spotifyInTimeout = false;
let timeoutUntil = null;

// TEMPORARY: Keep timeout active until Spotify's actual rate limit expires
// We know we're rate limited for ~24 hours starting Dec 12, 2025 ~4:30 PM EST
// Remove this line after Dec 13, 2025 6:00 PM EST
const rateLimitExpires = new Date('2025-12-13T18:00:00-05:00').getTime();
if (Date.now() < rateLimitExpires) {
  spotifyInTimeout = true;
  timeoutUntil = rateLimitExpires;
  console.log(`🚫 Known rate limit active until ${new Date(rateLimitExpires).toISOString()}`);
}

// Check if Spotify has us in timeout
function isSpotifyInTimeout() {
  if (!spotifyInTimeout) return false;
  if (timeoutUntil && Date.now() > timeoutUntil) {
    spotifyInTimeout = false;
    timeoutUntil = null;
    console.log('✅ Spotify timeout period expired');
    return false;
  }
  return true;
}

// Set Spotify timeout (triggered by severe rate limiting)
function setSpotifyTimeout(hours = 24) {
  spotifyInTimeout = true;
  timeoutUntil = Date.now() + (hours * 60 * 60 * 1000);
  console.log(`🚫 Spotify timeout activated until ${new Date(timeoutUntil).toISOString()}`);
}

// Helper function to check rate limit
function checkRateLimit(ip) {
  const now = Date.now();
  const userRequests = requestCounts.get(ip) || [];
  
  // Filter out requests older than the window
  const recentRequests = userRequests.filter(time => now - time < RATE_LIMIT_WINDOW);
  
  if (recentRequests.length >= MAX_REQUESTS_PER_MINUTE) {
    return false; // Rate limited
  }
  
  // Add current request
  recentRequests.push(now);
  requestCounts.set(ip, recentRequests);
  
  return true; // Allowed
}

// Helper function to get user IP
function getUserIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0] || 
         req.headers['x-real-ip'] || 
         req.connection.remoteAddress;
}

// Helper function to get cached artist or fetch with retry logic
async function getCachedArtist(artistId, token) {
  const cached = artistCache.get(artistId);
  
  if (cached && Date.now() - cached.timestamp < ARTIST_CACHE_TTL) {
    console.log(`✓ Cache hit for artist ${artistId}`);
    return cached.data;
  }
  
  // Fetch from Spotify with exponential backoff
  let retries = 0;
  const maxRetries = 3;
  
  while (retries < maxRetries) {
    try {
      // Add delay between requests to avoid rate limits (100ms)
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const response = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      // Cache the result
      artistCache.set(artistId, {
        data: response.data,
        timestamp: Date.now()
      });
      
      console.log(`✓ Fetched and cached artist ${artistId}`);
      return response.data;
    } catch (error) {
      if (error.response?.status === 429) {
        // Rate limited - cap wait time at 5 seconds max
        const retryAfter = parseInt(error.response.headers['retry-after'] || '2');
        const waitTime = Math.min(retryAfter * 1000, 5000); // Cap at 5 seconds
        
        // If Spotify wants us to wait more than 1 hour, activate timeout mode
        if (retryAfter > 3600) {
          console.error(`🚫 Severe rate limit detected (${retryAfter}s = ${Math.round(retryAfter/3600)} hours)`);
          setSpotifyTimeout(24); // Set 24 hour timeout
          throw new Error(`SPOTIFY_TIMEOUT`);
        }
        
        console.log(`⚠️  Rate limited for artist ${artistId}, waiting ${waitTime}ms before retry ${retries + 1}/${maxRetries}`);
        
        if (waitTime > 5000) {
          console.error(`❌ Rate limit too severe (${retryAfter}s requested), aborting`);
          throw new Error(`Rate limit exceeded - try again later`);
        }
        
        await new Promise(resolve => setTimeout(resolve, waitTime));
        retries++;
      } else {
        throw error;
      }
    }
  }
  
  throw new Error('Max retries exceeded for artist fetch');
}

// Clean up old rate limit data every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, requests] of requestCounts.entries()) {
    const recentRequests = requests.filter(time => now - time < RATE_LIMIT_WINDOW);
    if (recentRequests.length === 0) {
      requestCounts.delete(ip);
    } else {
      requestCounts.set(ip, recentRequests);
    }
  }
  console.log(`🧹 Cleaned up rate limit cache. Active IPs: ${requestCounts.size}`);
}, 5 * 60 * 1000);

// ========== END RATE LIMITING & CACHING ==========


// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Timeout status endpoint - check if Spotify has us rate limited
app.get('/api/timeout-status', (req, res) => {
  if (isSpotifyInTimeout()) {
    res.json({
      inTimeout: true,
      message: 'Spotify has put us in timeout due to high traffic',
      timeoutUntil: new Date(timeoutUntil).toISOString(),
      hoursRemaining: Math.ceil((timeoutUntil - Date.now()) / (1000 * 60 * 60))
    });
  } else {
    res.json({
      inTimeout: false,
      message: 'Service is operational'
    });
  }
});

// Serve static files from the React build in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'client/dist')));
}

// Spotify OAuth Configuration
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/callback';

// Base64 encode credentials for Spotify API
const getAuthToken = () => {
  return Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
};

// Get Spotify Access Token (Client Credentials Flow for public data)
let spotifyAccessToken = null;
let tokenExpiry = null;

async function getSpotifyToken() {
  if (spotifyAccessToken && tokenExpiry && Date.now() < tokenExpiry) {
    return spotifyAccessToken;
  }

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Authorization': `Basic ${getAuthToken()}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    spotifyAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000);
    return spotifyAccessToken;
  } catch (error) {
    console.error('Error getting Spotify token:', error.response?.data || error.message);
    throw error;
  }
}

// User token for playlist access (Owen's account)
let userAccessToken = null;
let userTokenExpiry = null;
const USER_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;

// Get User Access Token (for playlist access using Owen's account)
async function getUserAccessToken() {
  // If token is still valid, return it
  if (userAccessToken && userTokenExpiry && Date.now() < userTokenExpiry) {
    return userAccessToken;
  }

  if (!USER_REFRESH_TOKEN) {
    throw new Error('SPOTIFY_REFRESH_TOKEN not configured. Please set up Owen\'s refresh token.');
  }

  console.log('🔄 Refreshing user access token...');

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: USER_REFRESH_TOKEN
      }),
      {
        headers: {
          'Authorization': `Basic ${getAuthToken()}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    userAccessToken = response.data.access_token;
    userTokenExpiry = Date.now() + (response.data.expires_in * 1000);
    
    console.log('✅ User access token refreshed successfully');
    return userAccessToken;
  } catch (error) {
    console.error('❌ Error refreshing user token:', error.response?.data || error.message);
    throw error;
  }
}

// Spotify Authorization endpoint
app.get('/login', (req, res) => {
  const scopes = 'playlist-read-private playlist-read-collaborative';
  const authUrl = `https://accounts.spotify.com/authorize?` +
    `response_type=code&` +
    `client_id=${CLIENT_ID}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;
  
  res.json({ authUrl });
});

// ONE-TIME SETUP: Get Owen's refresh token
app.get('/setup-token', (req, res) => {
  const scopes = 'playlist-read-private playlist-read-collaborative';
  const authUrl = `https://accounts.spotify.com/authorize?` +
    `response_type=code&` +
    `client_id=${CLIENT_ID}&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `redirect_uri=${encodeURIComponent(REDIRECT_URI)}&` +
    `show_dialog=true`;
  
  res.redirect(authUrl);
});

// DEBUG: Check what the token can access
app.get('/debug-token', async (req, res) => {
  try {
    const token = await getUserAccessToken();
    
    // Try to get user's profile
    const profileResponse = await axios.get('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    // Try to get user's playlists
    const playlistsResponse = await axios.get('https://api.spotify.com/v1/me/playlists?limit=5', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    res.json({
      message: 'Token is valid',
      user: profileResponse.data.display_name || profileResponse.data.id,
      playlistCount: playlistsResponse.data.items.length,
      firstPlaylist: playlistsResponse.data.items[0]?.name || 'No playlists',
      firstPlaylistId: playlistsResponse.data.items[0]?.id || null
    });
  } catch (error) {
    res.status(500).json({
      error: 'Token error',
      details: error.response?.data || error.message
    });
  }
});

// Spotify Callback endpoint
app.get('/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.status(400).json({ error: 'No authorization code provided' });
  }

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: REDIRECT_URI
      }),
      {
        headers: {
          'Authorization': `Basic ${getAuthToken()}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    const { access_token, refresh_token, expires_in } = response.data;

    // If refresh token isn't configured yet, show it for setup
    if (!USER_REFRESH_TOKEN && refresh_token) {
      return res.send(`
        <html>
          <head>
            <title>Clout Calculator - Setup Complete</title>
            <style>
              body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; 
                max-width: 800px; 
                margin: 50px auto; 
                padding: 20px;
                background: #191414;
                color: #fff;
              }
              .token-box {
                background: #282828;
                padding: 20px;
                border-radius: 10px;
                margin: 20px 0;
                border: 2px solid #1db954;
              }
              code {
                background: #000;
                padding: 10px;
                display: block;
                border-radius: 5px;
                word-break: break-all;
                color: #1db954;
                font-size: 14px;
              }
              .success {
                color: #1db954;
                font-size: 28px;
                font-weight: bold;
                margin-bottom: 10px;
              }
              ol {
                line-height: 1.8;
              }
            </style>
          </head>
          <body>
            <h1 class="success">✅ Setup Complete!</h1>
            <p>Copy this refresh token and add it to Railway:</p>
            <div class="token-box">
              <code>${refresh_token}</code>
            </div>
            <h3>Next Steps:</h3>
            <ol>
              <li>Copy the token above (click to select all)</li>
              <li>Go to Railway → Your App → Variables tab</li>
              <li>Click "New Variable"</li>
              <li>Name: <code>SPOTIFY_REFRESH_TOKEN</code></li>
              <li>Value: Paste the token</li>
              <li>Click "Add" and Railway will auto-redeploy</li>
            </ol>
            <p style="color: #ff6b6b;"><strong>⚠️ Keep this token secret!</strong> Anyone with it can access playlists as you.</p>
            <p style="margin-top: 40px; color: #888;">Once added to Railway, your app will work for everyone forever! 🎉</p>
          </body>
        </html>
      `);
    }

    // In production, redirect to root with token
    // In development, return JSON
    if (process.env.NODE_ENV === 'production') {
      res.redirect(`/?access_token=${access_token}`);
    } else {
      res.json({ access_token, refresh_token, expires_in });
    }
  } catch (error) {
    console.error('Error exchanging code for token:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to authenticate with Spotify' });
  }
});

// Get user's playlists
app.get('/api/playlists', async (req, res) => {
  const userToken = req.headers.authorization?.split(' ')[1];

  if (!userToken) {
    return res.status(401).json({ error: 'No access token provided' });
  }

  try {
    let allPlaylists = [];
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';

    // Paginate through all playlists
    while (url) {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${userToken}`
        }
      });

      allPlaylists = allPlaylists.concat(response.data.items);
      url = response.data.next; // Next page URL, or null if done
    }

    res.json({ items: allPlaylists });
  } catch (error) {
    console.error('Error fetching playlists:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch playlists' });
  }
});

// Get playlist tracks with added dates
app.get('/api/playlist/:playlistId/tracks', async (req, res) => {
  const { playlistId } = req.params;
  const userToken = req.headers.authorization?.split(' ')[1];

  if (!userToken) {
    return res.status(401).json({ error: 'No access token provided' });
  }

  try {
    let allTracks = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;

    while (url) {
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${userToken}`
        },
        params: {
          limit: 100
        }
      });

      allTracks = allTracks.concat(response.data.items);
      url = response.data.next;
    }

    res.json({ tracks: allTracks });
  } catch (error) {
    console.error('Error fetching playlist tracks:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch playlist tracks' });
  }
});

// Get current artist data from Spotify
app.get('/api/artist/:artistId', async (req, res) => {
  const { artistId } = req.params;

  try {
    const token = await getSpotifyToken();
    const response = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    res.json(response.data);
  } catch (error) {
    console.error('Error fetching artist data:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch artist data' });
  }
});

// Scrape artist.tools for historical monthly listeners
app.get('/api/artist/:artistId/history', async (req, res) => {
  const { artistId } = req.params;

  try {
    // First, get artist name from Spotify
    const token = await getSpotifyToken();
    const artistResponse = await axios.get(`https://api.spotify.com/v1/artists/${artistId}`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    const artistName = artistResponse.data.name;

    // Try to fetch from artist.tools (they may have an API or we'll need to scrape)
    // For now, we'll return a placeholder that indicates we need to implement the scraping
    res.json({
      artistId,
      artistName,
      message: 'Historical data integration pending - need to implement artist.tools scraping',
      currentListeners: artistResponse.data.followers.total,
      popularity: artistResponse.data.popularity
    });
  } catch (error) {
    console.error('Error fetching artist history:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to fetch artist history' });
  }
});

// Calculate clout score for a playlist
app.post('/api/calculate-clout', async (req, res) => {
  const { playlistId, tracks } = req.body;

  if (!tracks || !Array.isArray(tracks)) {
    return res.status(400).json({ error: 'Invalid tracks data' });
  }

  try {
    const token = await getSpotifyToken();
    const scraper = require('./artistToolsScraper');
    const cloutData = [];

    for (const track of tracks) {
      if (!track.track || !track.track.artists) continue;

      const artist = track.track.artists[0];
      const addedAt = new Date(track.added_at);

      // Get current artist data with caching
      const artistData = await getCachedArtist(artist.id, token);

      const currentFollowers = artistData.followers.total;
      const popularity = artistData.popularity;

      // Estimate what monthly listeners were when track was added
      // Note: Using followers as proxy for monthly listeners
      // In reality, monthly listeners ≈ followers * 2-5x depending on artist
      const estimatedListenersWhenAdded = scraper.estimateListenersAtDate(currentFollowers, addedAt);
      
      // Calculate inflation-adjusted clout score
      const cloutMetrics = scraper.calculateCloutScore(
        estimatedListenersWhenAdded,
        currentFollowers,
        addedAt
      );

      cloutData.push({
        trackName: track.track.name,
        artistName: artist.name,
        artistId: artist.id,
        addedAt: track.added_at,
        addedAgo: Math.floor((Date.now() - addedAt) / (1000 * 60 * 60 * 24 / 30)) + ' months ago',
        currentFollowers,
        followersWhenAdded: estimatedListenersWhenAdded,
        popularity,
        rawGrowth: Math.round(cloutMetrics.rawGrowth),
        inflationAdjustedGrowth: cloutMetrics.inflationAdjustedGrowth,
        discoveryTier: cloutMetrics.discoveryTier,
        earlyDiscoveryBonus: cloutMetrics.earlyDiscoveryMultiplier,
        cloutScore: cloutMetrics.score
      });
    }

    // Calculate total playlist clout score
    const totalClout = cloutData.reduce((sum, item) => sum + item.cloutScore, 0);
    const averageClout = totalClout / cloutData.length;
    
    // Normalized score: average × √(track_count)
    const normalizedScore = averageClout * Math.sqrt(cloutData.length);

    // Sort by clout score (highest first)
    cloutData.sort((a, b) => b.cloutScore - a.cloutScore);

    res.json({
      playlistId,
      averageClout: Math.round(averageClout),
      normalizedScore: Math.round(normalizedScore),
      totalClout: Math.round(totalClout),
      trackCount: cloutData.length,
      tracks: cloutData,
      note: 'Scores are inflation-adjusted. Normalized score accounts for playlist size.'
    });
  } catch (error) {
    console.error('Error calculating clout:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to calculate clout score' });
  }
});

// New endpoint: Analyze public playlist without user auth
app.post('/api/analyze-public-playlist', async (req, res) => {
  const { playlistId } = req.body;
  const userIP = getUserIP(req);

  console.log('Received playlist analysis request for:', playlistId, 'from IP:', userIP);

  // Check if Spotify has us in timeout
  if (isSpotifyInTimeout()) {
    const hoursRemaining = Math.ceil((timeoutUntil - Date.now()) / (1000 * 60 * 60));
    console.log(`🚫 Request rejected - in Spotify timeout (${hoursRemaining}h remaining)`);
    return res.status(503).json({ 
      error: 'SPOTIFY_TIMEOUT',
      message: `Spotify has put us in timeout due to high traffic. Please try again in ${hoursRemaining} hour(s).`,
      timeoutUntil: new Date(timeoutUntil).toISOString()
    });
  }

  // Check if already processing (queue)
  if (isProcessing) {
    console.log(`⏳ Request queued - already processing another playlist`);
    return res.status(429).json({ 
      error: 'PROCESSING',
      message: 'Another playlist is currently being analyzed. Please try again in a moment.'
    });
  }

  // Check rate limit
  if (!checkRateLimit(userIP)) {
    console.log(`⛔ Rate limit exceeded for IP: ${userIP}`);
    return res.status(429).json({ 
      error: 'Too many requests. Please wait a minute before trying again.' 
    });
  }

  if (!playlistId) {
    return res.status(400).json({ error: 'Playlist ID is required' });
  }

  // Mark as processing
  isProcessing = true;

  try {
    // Use Owen's user token for playlist access (playlists require user auth)
    const userToken = await getUserAccessToken();
    console.log('Got user token for playlist access');
    console.log('Token preview:', userToken.substring(0, 20) + '...');
    console.log('Token length:', userToken.length);
    
    // Get playlist info
    const playlistUrl = `https://api.spotify.com/v1/playlists/${playlistId}`;
    console.log('Requesting:', playlistUrl);
    
    const playlistResponse = await axios.get(playlistUrl, {
      headers: {
        'Authorization': `Bearer ${userToken}`
      }
    }).catch(err => {
      console.error('Spotify API Error Details:', {
        status: err.response?.status,
        statusText: err.response?.statusText,
        data: err.response?.data,
        url: playlistUrl,
        authHeaderPresent: !!err.config?.headers?.Authorization
      });
      
      // If 404, playlist might be private or not exist
      if (err.response?.status === 404) {
        throw new Error('PRIVATE_PLAYLIST');
      }
      throw err;
    });

    console.log('✅ Playlist found:', playlistResponse.data.name);

    const playlistName = playlistResponse.data.name;
    
    // Get all tracks with pagination (using user token)
    let allTracks = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

    while (url) {
      const tracksResponse = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${userToken}`
        }
      });

      allTracks = allTracks.concat(tracksResponse.data.items);
      url = tracksResponse.data.next;
    }

    console.log(`Found ${allTracks.length} tracks, analyzing...`);
    
    // For artist data, use client credentials (more rate limit headroom)
    const clientToken = await getSpotifyToken();
    
    // Calculate clout for each track
    const scraper = require('./artistToolsScraper');
    const cloutData = [];

    for (const track of allTracks) {
      // Skip tracks with missing data
      if (!track.track) {
        console.log('⚠️  Skipping track: no track data');
        continue;
      }
      
      if (!track.track.artists || track.track.artists.length === 0) {
        console.log('⚠️  Skipping track:', track.track.name, '- no artists');
        continue;
      }

      const artist = track.track.artists[0];
      
      if (!artist.id) {
        console.log('⚠️  Skipping track:', track.track.name, '- artist has no ID');
        continue;
      }
      
      const addedAt = new Date(track.added_at);

      try {
        // Get current artist data with caching and retry logic (using client credentials)
        const artistData = await getCachedArtist(artist.id, clientToken);

        const currentFollowers = artistData.followers.total;
        const popularity = artistData.popularity;

        // Estimate listeners when track was added
        const estimatedListenersWhenAdded = scraper.estimateListenersAtDate(currentFollowers, addedAt);
        
        // Calculate inflation-adjusted clout score
        const cloutMetrics = scraper.calculateCloutScore(
          estimatedListenersWhenAdded,
          currentFollowers,
          addedAt
        );

        cloutData.push({
          trackName: track.track.name || 'Unknown',
          artistName: artist.name || 'Unknown',
          artistId: artist.id,
          addedAt: track.added_at,
          addedAgo: Math.floor((Date.now() - addedAt) / (1000 * 60 * 60 * 24 / 30)) + ' months ago',
          currentFollowers,
          followersWhenAdded: estimatedListenersWhenAdded,
          popularity,
          rawGrowth: Math.round(cloutMetrics.rawGrowth),
          inflationAdjustedGrowth: cloutMetrics.inflationAdjustedGrowth,
          discoveryTier: cloutMetrics.discoveryTier,
          tierEmoji: cloutMetrics.tierEmoji,
          tierColor: cloutMetrics.tierColor,
          earlyDiscoveryBonus: cloutMetrics.earlyDiscoveryMultiplier,
          cloutScore: cloutMetrics.score
        });
      } catch (error) {
        console.error('❌ Error processing track:', track.track?.name || 'Unknown', '-', error.message);
        // Skip this track and continue with the rest
        continue;
      }
    }

    console.log(`✅ Successfully analyzed ${cloutData.length} out of ${allTracks.length} tracks`);

    if (cloutData.length === 0) {
      // Check if we failed due to timeout
      if (isSpotifyInTimeout()) {
        const hoursRemaining = Math.ceil((timeoutUntil - Date.now()) / (1000 * 60 * 60));
        return res.status(503).json({ 
          error: 'SPOTIFY_TIMEOUT',
          message: `Spotify has put us in timeout due to high traffic. Please try again in ${hoursRemaining} hour(s).`,
          timeoutUntil: new Date(timeoutUntil).toISOString()
        });
      }
      
      return res.status(400).json({ 
        error: 'No valid tracks found in playlist. Playlist may contain only podcasts or local files.' 
      });
    }

    // Calculate totals
    const totalClout = cloutData.reduce((sum, item) => sum + item.cloutScore, 0);
    const averageClout = totalClout / cloutData.length;
    
    // Normalized score: average × √(track_count)
    // This rewards larger playlists slightly but not linearly
    // Prevents big playlists from dominating just due to size
    const normalizedScore = averageClout * Math.sqrt(cloutData.length);

    // Sort by clout score
    cloutData.sort((a, b) => b.cloutScore - a.cloutScore);

    res.json({
      playlistId,
      playlistName,
      averageClout: Math.round(averageClout),
      normalizedScore: Math.round(normalizedScore),
      totalClout: Math.round(totalClout),
      trackCount: cloutData.length,
      tracks: cloutData,
      note: 'Scores are inflation-adjusted. Normalized score accounts for playlist size using √(track_count).'
    });
  } catch (error) {
    console.error('Error analyzing playlist:', error.message);
    
    // Check for Spotify timeout error
    if (error.message === 'SPOTIFY_TIMEOUT') {
      const hoursRemaining = Math.ceil((timeoutUntil - Date.now()) / (1000 * 60 * 60));
      return res.status(503).json({ 
        error: 'SPOTIFY_TIMEOUT',
        message: `Spotify has put us in timeout due to high traffic. Please try again in ${hoursRemaining} hour(s).`,
        timeoutUntil: new Date(timeoutUntil).toISOString()
      });
    }
    
    if (error.message === 'PRIVATE_PLAYLIST') {
      return res.status(404).json({ 
        error: 'This playlist is private or requires authentication. Please make sure the playlist is public.' 
      });
    }
    
    if (error.response?.status === 404) {
      return res.status(404).json({ error: 'Playlist not found or is private' });
    }
    
    if (error.response?.status === 401) {
      return res.status(500).json({ error: 'Authentication error. Please try again.' });
    }
    
    res.status(500).json({ error: 'Failed to analyze playlist' });
  } finally {
    // Always release the processing lock
    isProcessing = false;
    console.log('🔓 Processing lock released');
  }
});

// Serve React app for all other routes in production
if (process.env.NODE_ENV === 'production') {
  const distPath = path.join(__dirname, 'client/dist/index.html');
  console.log(`📂 Looking for index.html at: ${distPath}`);
  
  app.use((req, res, next) => {
    // Don't catch API routes
    if (req.path.startsWith('/api') || req.path.startsWith('/login') || req.path.startsWith('/callback')) {
      return next();
    }
    
    res.sendFile(distPath, (err) => {
      if (err) {
        console.error('Error serving index.html:', err);
        res.status(500).send('Failed to load application');
      }
    });
  });
}

app.listen(PORT, () => {
  console.log(`🎵 Clout Calculator API running on port ${PORT}`);
  console.log(`📊 Environment variables loaded: ${!!process.env.SPOTIFY_CLIENT_ID}`);
  if (process.env.NODE_ENV === 'production') {
    console.log(`🚀 Serving production build from /client/dist`);
  }
});
