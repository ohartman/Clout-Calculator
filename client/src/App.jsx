import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './App.css';

function App() {
  const [playlistUrl, setPlaylistUrl] = useState('');
  const [playlists, setPlaylists] = useState([]);
  const [selectedPlaylist, setSelectedPlaylist] = useState(null);
  const [cloutResults, setCloutResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [spotifyTimeout, setSpotifyTimeout] = useState(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, message: '' });

  // Check timeout status on mount
  useEffect(() => {
    const checkTimeout = async () => {
      try {
        const response = await axios.get('/api/timeout-status');
        if (response.data.inTimeout) {
          setSpotifyTimeout(response.data);
        }
      } catch (err) {
        console.error('Error checking timeout status:', err);
      }
    };
    checkTimeout();
  }, []);

  const extractPlaylistId = (url) => {
    // Extract playlist ID from Spotify URL
    // Formats: https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M
    // or spotify:playlist:37i9dQZF1DXcBWIGoYBM5M
    const match = url.match(/playlist[\/:]([a-zA-Z0-9]+)/);
    return match ? match[1] : null;
  };

  const analyzePlaylist = async (e) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setCloutResults(null);
    setProgress({ current: 0, total: 100, message: 'Starting analysis...' });
    
    const playlistId = extractPlaylistId(playlistUrl);
    
    if (!playlistId) {
      setError('Invalid Spotify playlist URL. Please paste a valid playlist link.');
      setLoading(false);
      return;
    }

    try {
      // Simulate progress with intervals
      const progressInterval = setInterval(() => {
        setProgress(prev => {
          if (prev.current >= 90) return prev; // Cap at 90% until done
          const increment = Math.random() * 15 + 5; // Random increment 5-20%
          const newCurrent = Math.min(prev.current + increment, 90);
          
          let message = 'Starting analysis...';
          if (newCurrent > 10) message = 'Fetching playlist tracks...';
          if (newCurrent > 30) message = 'Analyzing artist growth...';
          if (newCurrent > 60) message = 'Calculating clout scores...';
          
          return { ...prev, current: newCurrent, message };
        });
      }, 800);

      // Fetch playlist info and calculate clout
      const response = await axios.post('/api/analyze-public-playlist', {
        playlistId
      });

      clearInterval(progressInterval);
      setProgress({ current: 100, total: 100, message: 'Complete!' });

      setCloutResults(response.data);
      setSelectedPlaylist({ name: response.data.playlistName });
    } catch (err) {
      console.error('Analysis error:', err);
      console.error('Error response status:', err.response?.status);
      console.error('Error response data:', err.response?.data);
      
      // Check for Spotify timeout error (503 status or SPOTIFY_TIMEOUT error)
      if (err.response?.status === 503 || err.response?.data?.error === 'SPOTIFY_TIMEOUT') {
        console.log('DETECTED TIMEOUT ERROR');
        setSpotifyTimeout(err.response.data);
        setError(err.response.data.message);
      } else if (err.response?.data?.error === 'PROCESSING') {
        setError('Another playlist is currently being analyzed. Please try again in a moment.');
      } else if (err.response?.status === 404) {
        setError('Playlist not found. Make sure the playlist is public.');
      } else if (err.response?.status === 429) {
        setError('Too many requests. Please wait a moment and try again.');
      } else {
        setError('Failed to analyze playlist. Please make sure it\'s a public playlist and try again.');
      }
    } finally {
      setLoading(false);
      setProgress({ current: 0, total: 0, message: '' });
    }
  };

  return (
    <div className="app">
      <header>
        <div>
          <h1>🎵 Clout Calculator</h1>
          <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.85rem', marginTop: '0.25rem' }}>
            Designed by Owen Hartman
          </p>
        </div>
        <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.9rem' }}>Public Playlist Analyzer</p>
      </header>

      {spotifyTimeout && (
        <div className="timeout-banner">
          <div className="timeout-icon">⏰</div>
          <div className="timeout-content">
            <h3>Spotify Timeout</h3>
            <p>
              Spotify has put us in timeout due to high traffic. 
              {spotifyTimeout.hoursRemaining ? (
                <> We'll be back in approximately <strong>{spotifyTimeout.hoursRemaining} hour{spotifyTimeout.hoursRemaining !== 1 ? 's' : ''}</strong>.</>
              ) : (
                <> Please try again later.</>
              )}
            </p>
            <p style={{fontSize: '0.85rem', opacity: 0.8, marginTop: '0.5rem'}}>
              Sorry for the inconvenience! This happens when too many people use the app at once.
            </p>
          </div>
        </div>
      )}

      {error && <div className="error">{error}</div>}

      {!cloutResults && !loading && (
        <div className="input-section">
          <h2>Analyze Any Public Spotify Playlist</h2>
          <p className="subtitle">Paste a Spotify playlist URL to see the clout score</p>
          
          <form onSubmit={analyzePlaylist} className="url-form">
            <div className="input-wrapper">
              <input
                type="text"
                value={playlistUrl}
                onChange={(e) => setPlaylistUrl(e.target.value)}
                placeholder="https://open.spotify.com/playlist/..."
                className="url-input"
                disabled={loading}
              />
              {playlistUrl && (
                <button
                  type="button"
                  onClick={() => setPlaylistUrl('')}
                  className="clear-btn"
                  disabled={loading}
                  aria-label="Clear"
                >
                  ✕
                </button>
              )}
            </div>
            <button type="submit" className="analyze-btn" disabled={loading}>
              Calculate Clout
            </button>
          </form>

          <div className="notice" style={{marginTop: '1.5rem'}}>
            ⚠️ <strong>User-Generated Playlists Only:</strong> This app only works with playlists created by users. Spotify's editorial playlists (Today's Top Hits, RapCaviar, etc.) are not accessible via the API.
          </div>
        </div>
      )}

      {loading && cloutResults === null && (
        <div className="loading">
          <div className="progress-container">
            <div className="progress-message">{progress.message}</div>
            <div className="progress-bar-wrapper">
              <div 
                className="progress-bar-fill" 
                style={{ width: `${progress.current}%` }}
              />
            </div>
            <div className="progress-percentage">{Math.round(progress.current)}%</div>
          </div>
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
                <h3>🏆 Normalized Clout</h3>
                <div className="score-value">{cloutResults.normalizedScore?.toFixed(0) || 0}</div>
                <p style={{fontSize: '0.85rem', color: 'rgba(255,255,255,0.6)', marginTop: '0.5rem'}}>
                  Size-adjusted score
                </p>
              </div>
              <div className="score-card">
                <h3>Average Per Track</h3>
                <div className="score-value" style={{fontSize: '2rem'}}>{cloutResults.averageClout?.toFixed(1) || 0}</div>
              </div>
              <div className="score-card">
                <h3>Tracks Analyzed</h3>
                <div className="score-value" style={{fontSize: '2rem'}}>{cloutResults.trackCount || 0}</div>
              </div>
            </div>
          </div>

          <div className="tracks-list">
            <h3>Track Breakdown</h3>
            <div className="notice">
              ✨ <strong>How scoring works:</strong> Your score rewards discovering artists early AND who became relevant. Small artists who stay small score low (relevance penalty). Artists who decline give negative scores. Bigger playlists get normalized using √(tracks). All scores are inflation-adjusted for Spotify's ~17% annual growth.
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
                      <span 
                        className="discovery-tier" 
                        style={{ 
                          background: `linear-gradient(135deg, ${track.tierColor}22, ${track.tierColor}44)`,
                          border: `1px solid ${track.tierColor}66`,
                          color: track.tierColor
                        }}
                      >
                        {track.tierEmoji} {track.discoveryTier || 'N/A'}
                      </span>
                    </td>
                    <td>{track.addedAgo || 'N/A'}</td>
                    <td>{track.followersWhenAdded?.toLocaleString() || 'N/A'}</td>
                    <td>{track.currentFollowers?.toLocaleString() || 'N/A'}</td>
                    <td className={track.inflationAdjustedGrowth > 0 ? 'positive-growth' : 'negative-growth'}>
                      {track.inflationAdjustedGrowth > 0 ? '+' : ''}{track.inflationAdjustedGrowth || 0}%
                    </td>
                    <td className={track.cloutScore >= 0 ? 'clout-score positive-clout' : 'clout-score negative-clout'}>
                      {track.cloutScore >= 0 ? '+' : ''}{track.cloutScore || 0}
                    </td>
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
