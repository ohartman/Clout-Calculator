const axios = require('axios');

/**
 * Artist.tools Historical Data Scraper
 * 
 * This module attempts to fetch historical monthly listener data from artist.tools
 * Note: This is a scraping approach - ideally we'd use their API if available
 */

class ArtistToolsScraper {
  constructor() {
    this.baseUrl = 'https://www.artist.tools';
    this.cache = new Map();
  }

  /**
   * Get historical monthly listeners for an artist
   * @param {string} artistName - Name of the artist
   * @param {string} spotifyId - Spotify artist ID
   * @returns {Promise<Object>} Historical data object
   */
  async getHistoricalData(artistName, spotifyId) {
    // Check cache first
    const cacheKey = `${spotifyId}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      // Artist.tools uses Spotify IDs in their URLs
      const url = `${this.baseUrl}/artist/${spotifyId}`;
      
      // For now, we'll make a simple request
      // In production, we'd need proper scraping with puppeteer or their API
      const response = await axios.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        },
        timeout: 10000
      });

      // Parse the HTML to extract historical data
      // This is a placeholder - actual implementation would parse the page
      const historicalData = {
        artistName,
        spotifyId,
        available: false,
        message: 'Artist.tools integration pending - need to parse HTML or use their API',
        dataPoints: []
      };

      // Cache the result
      this.cache.set(cacheKey, historicalData);
      
      return historicalData;
    } catch (error) {
      console.error(`Error fetching data for ${artistName}:`, error.message);
      
      return {
        artistName,
        spotifyId,
        available: false,
        error: error.message,
        dataPoints: []
      };
    }
  }

  /**
   * Estimate monthly listeners at a specific date
   * This is a fallback when historical data isn't available
   * @param {number} currentListeners - Current monthly listeners
   * @param {Date} addedDate - Date the song was added
   * @returns {number} Estimated listeners at added date
   */
  estimateListenersAtDate(currentListeners, addedDate) {
    const now = new Date();
    const monthsAgo = (now - addedDate) / (1000 * 60 * 60 * 24 * 30);
    
    // Spotify's average user growth is ~15-20% per year
    // This causes natural inflation in monthly listeners
    // We'll use 17% annual growth (1.3% monthly) as baseline
    const spotifyGrowthRate = 0.013; // 1.3% per month
    
    // Artist growth rate (varies by size)
    // Smaller artists grow faster percentage-wise
    let artistGrowthRate;
    if (currentListeners < 10000) {
      artistGrowthRate = 0.05; // 5% monthly for small artists
    } else if (currentListeners < 100000) {
      artistGrowthRate = 0.03; // 3% monthly for medium artists
    } else if (currentListeners < 1000000) {
      artistGrowthRate = 0.02; // 2% monthly for large artists
    } else {
      artistGrowthRate = 0.01; // 1% monthly for mega artists
    }
    
    // Combined growth rate (artist + platform)
    const combinedGrowthRate = artistGrowthRate + spotifyGrowthRate;
    
    // Calculate past listeners accounting for both growths
    const estimatedPastListeners = currentListeners / Math.pow(1 + combinedGrowthRate, monthsAgo);
    
    return Math.floor(estimatedPastListeners);
  }

  /**
   * Calculate growth percentage
   * @param {number} currentListeners - Current monthly listeners
   * @param {number} pastListeners - Past monthly listeners
   * @returns {number} Growth percentage
   */
  calculateGrowth(currentListeners, pastListeners) {
    if (pastListeners === 0) return 0;
    return ((currentListeners - pastListeners) / pastListeners) * 100;
  }

  /**
   * Calculate inflation-adjusted growth
   * Removes the natural Spotify platform growth to show real artist discovery
   * @param {number} currentListeners - Current monthly listeners
   * @param {number} pastListeners - Past monthly listeners
   * @param {Date} addedDate - When the track was added
   * @returns {number} Inflation-adjusted growth percentage
   */
  calculateInflationAdjustedGrowth(currentListeners, pastListeners, addedDate) {
    const now = new Date();
    const monthsAgo = (now - addedDate) / (1000 * 60 * 60 * 24 * 30);
    
    // Spotify platform growth: ~17% per year = 1.3% per month
    const spotifyGrowthRate = 0.013;
    const platformInflation = Math.pow(1 + spotifyGrowthRate, monthsAgo);
    
    // Adjust current listeners to remove platform inflation
    const inflationAdjustedCurrent = currentListeners / platformInflation;
    
    // Now calculate growth against adjusted baseline
    const rawGrowth = ((inflationAdjustedCurrent - pastListeners) / pastListeners) * 100;
    
    return rawGrowth;
  }

  /**
   * Calculate clout score based on discovery timing
   * @param {number} listenerAtAdd - Listeners when added
   * @param {number} currentListeners - Current listeners
   * @param {Date} addedDate - When track was added
   * @returns {Object} Clout score with breakdown
   */
  calculateCloutScore(listenerAtAdd, currentListeners, addedDate) {
    // Get inflation-adjusted growth
    const inflationAdjustedGrowth = this.calculateInflationAdjustedGrowth(
      currentListeners, 
      listenerAtAdd, 
      addedDate
    );
    
    // Early discovery bonus: smaller artists get more points
    let earlyDiscoveryMultiplier = 1;
    let discoveryTier = 'Mainstream';
    
    if (listenerAtAdd < 1000) {
      earlyDiscoveryMultiplier = 10;
      discoveryTier = 'Underground Legend';
    } else if (listenerAtAdd < 10000) {
      earlyDiscoveryMultiplier = 5;
      discoveryTier = 'Early Adopter';
    } else if (listenerAtAdd < 100000) {
      earlyDiscoveryMultiplier = 3;
      discoveryTier = 'Ahead of Curve';
    } else if (listenerAtAdd < 1000000) {
      earlyDiscoveryMultiplier = 2;
      discoveryTier = 'Rising Star Hunter';
    } else if (listenerAtAdd < 10000000) {
      earlyDiscoveryMultiplier = 1.5;
      discoveryTier = 'Trending Finder';
    }
    
    // Base score is inflation-adjusted growth percentage
    const baseScore = Math.max(0, inflationAdjustedGrowth);
    
    // Apply multiplier
    const finalScore = baseScore * earlyDiscoveryMultiplier;
    
    return {
      score: Math.round(finalScore),
      inflationAdjustedGrowth: Math.round(inflationAdjustedGrowth),
      rawGrowth: this.calculateGrowth(currentListeners, listenerAtAdd),
      earlyDiscoveryMultiplier,
      discoveryTier,
      listenersAtDiscovery: listenerAtAdd
    };
  }

  /**
   * Clear the cache
   */
  clearCache() {
    this.cache.clear();
  }
}

module.exports = new ArtistToolsScraper();
