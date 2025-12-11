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
    const response = await axios.get('https://api.spotify.com/v1/me/playlists', {
      headers: {
        'Authorization': `Bearer ${userToken}`
      },
      params: {
        limit: 50
      }
    });

    res.json(response.data);
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

      // Get current artist data
      const artistResponse = await axios.get(`https://api.spotify.com/v1/artists/${artist.id}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      const currentFollowers = artistResponse.data.followers.total;
      const popularity = artistResponse.data.popularity;

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

    // Sort by clout score (highest first)
    cloutData.sort((a, b) => b.cloutScore - a.cloutScore);

    res.json({
      playlistId,
      totalClout: Math.round(totalClout),
      averageClout: Math.round(averageClout),
      trackCount: cloutData.length,
      tracks: cloutData,
      note: 'Scores are inflation-adjusted to account for Spotify platform growth'
    });
  } catch (error) {
    console.error('Error calculating clout:', error.response?.data || error.message);
    res.status(500).json({ error: 'Failed to calculate clout score' });
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
