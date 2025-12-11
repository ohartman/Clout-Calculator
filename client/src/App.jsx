import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [accessToken, setAccessToken] = useState(localStorage.getItem('spotify_token'));
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [cloutResults, setCloutResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    // Check for token in URL (from OAuth callback)
    const params = new URLSearchParams(window.location.search);
    const token = params.get('access_token');
    
    if (token) {
      setAccessToken(token);
      localStorage.setItem('spotify_token', token);
      // Clean up URL
      window.history.replaceState({}, document.title, '/');
    }
  }, []);

  useEffect(() => {
    if (accessToken) {
      fetchPlaylists();
    }
  }, [accessToken]);

  const handleLogin = async () => {
    try {
      const response = await axios.get('/login');
      window.location.href = response.data.authUrl;
    } catch (err) {
      setError('Failed to initiate login');
      console.error(err);
    }
  };

  const fetchPlaylists = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.get('/api/playlists', {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });
      setPlaylists(response.data.items);
    } catch (err) {
      console.error('Playlist fetch error:', err);
      
      if (err.response?.status === 401) {
        setError('Session expired. Please log in again.');
        localStorage.removeItem('spotify_token');
        setAccessToken(null);
      } else if (err.response?.status === 429) {
        setError('Too many requests. Please wait a moment and try again.');
      } else if (!navigator.onLine) {
        setError('No internet connection. Please check your network.');
      } else {
        setError('Failed to fetch playlists. Please try refreshing the page.');
      }
    } finally {
      setLoading(false);
    }
  };

  const calculateClout = async (playlistId) => {
    setLoading(true);
    setError(null);
    setCloutResults(null);

    try {
      // First, get all tracks from the playlist
      const tracksResponse = await axios.get(`/api/playlist/${playlistId}/tracks`, {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      });

      // Then calculate clout
      const cloutResponse = await axios.post('/api/calculate-clout', {
        playlistId,
        tracks: tracksResponse.data.tracks
      });

      setCloutResults(cloutResponse.data);
      setSelectedPlaylist(playlists.find(p => p.id === playlistId));
    } catch (err) {
      setError('Failed to calculate clout score');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.removeItem('spotify_token');
    setAccessToken(null);
    setPlaylists([]);
    setSelectedPlaylist(null);
    setCloutResults(null);
  };

  if (!accessToken) {
    return (
      <div className="app">
        <div className="login-container">
          <h1>🎵 Clout Calculator</h1>
          <p>Measure the influence of your music taste</p>
          <button onClick={handleLogin} className="login-btn">
            Login with Spotify
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header>
        <h1>🎵 Clout Calculator</h1>
        <button onClick={logout} className="logout-btn">Logout</button>
      </header>

      {error && <div className="error">{error}</div>}

      {!cloutResults && (
        <div className="playlists-section">
          <h2>Your Playlists</h2>
          {loading ? (
            <div className="loading">Loading playlists...</div>
          ) : (
            <div className="playlists-grid">
              {playlists.map(playlist => (
                <div key={playlist.id} className="playlist-card">
                  {playlist.images && playlist.images.length > 0 && playlist.images[0] && (
                    <img src={playlist.images[0].url} alt={playlist.name} />
                  )}
                  <h3>{playlist.name}</h3>
                  <p>{playlist.tracks.total} tracks</p>
                  <button 
                    onClick={() => calculateClout(playlist.id)}
                    disabled={loading}
                  >
                    Calculate Clout
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {loading && cloutResults === null && (
        <div className="loading">
          <div className="spinner"></div>
          <p>Calculating clout score...</p>
        </div>
      )}

      {cloutResults && (
        <div className="results-section">
          <button onClick={() => setCloutResults(null)} className="back-btn">
            ← Back to Playlists
          </button>

          <div className="results-header">
            <h2>{selectedPlaylist?.name}</h2>
            <div className="score-container">
              <div className="score-card">
                <h3>Total Clout Score</h3>
                <div className="score-value">{cloutResults.totalClout?.toFixed(0) || 0}</div>
              </div>
              <div className="score-card">
                <h3>Average Clout</h3>
                <div className="score-value">{cloutResults.averageClout?.toFixed(1) || 0}</div>
              </div>
              <div className="score-card">
                <h3>Tracks Analyzed</h3>
                <div className="score-value">{cloutResults.trackCount || 0}</div>
              </div>
            </div>
          </div>

          <div className="tracks-list">
            <h3>Track Breakdown</h3>
            <div className="notice">
              ✨ Scores are inflation-adjusted to account for Spotify's platform growth (~17% annually)
            </div>
            <div className="scroll-hint">
              👉 Swipe left to see all columns →
            </div>
            {cloutResults.tracks && cloutResults.tracks.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Track</th>
                  <th>Artist</th>
                  <th>Discovery Tier</th>
                  <th>Added</th>
                  <th>Followers Then</th>
                  <th>Followers Now</th>
                  <th>Real Growth</th>
                  <th>Clout Score</th>
                </tr>
              </thead>
              <tbody>
                {cloutResults.tracks.map((track, index) => (
                  <tr key={index}>
                    <td>{track.trackName || 'Unknown'}</td>
                    <td>{track.artistName || 'Unknown'}</td>
                    <td>
                      <span className={`discovery-tier ${track.discoveryTier ? 'tier-' + track.discoveryTier.toLowerCase().replace(/\s/g, '-') : 'tier-mainstream'}`}>
                        {track.discoveryTier || 'N/A'}
                      </span>
                    </td>
                    <td>{track.addedAgo || 'N/A'}</td>
                    <td>{track.followersWhenAdded?.toLocaleString() || 'N/A'}</td>
                    <td>{track.currentFollowers?.toLocaleString() || 'N/A'}</td>
                    <td className={track.inflationAdjustedGrowth > 0 ? 'positive-growth' : 'negative-growth'}>
                      {track.inflationAdjustedGrowth > 0 ? '+' : ''}{track.inflationAdjustedGrowth || 0}%
                    </td>
                    <td className="clout-score">{track.cloutScore || 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            ) : (
              <div className="notice">No tracks found in this playlist.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
