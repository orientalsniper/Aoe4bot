const fetch = require('node-fetch');

function fetchAOE4World(path, params) {
  var querystr = new URLSearchParams(params).toString();
  var url = 'https://aoe4world.com/api/v0' + path + (querystr.length ? '?' + querystr : '');

  var startTime = performance.now();
  console.log(`  Req: ${url}`);
  return fetch(url)
    .then((resp) => {
      const endTime = performance.now();
      const elapsed = endTime - startTime;
      console.log(`  Res: ${url} (${resp.status}, ${elapsed.toFixed(0)} msec)`);
      // 404 can happen for /games/last
      if (resp.status == 404)
        return null;
      if (resp.status != 200) {
        console.log(`  Err: ${url}: Invalid response`);
        return null;
      }
      return resp.json();
    })
    .catch((err) => {
      const endTime = performance.now();
      const elapsed = endTime - startTime;
      console.log(`  Err: ${url}: ${err}, ${elapsed.toFixed(0)} msec`);
      return null;
    });
}

function isValidLeaderboard(leaderboard) {
  if (/^[qr]m_\dv\d$/.test(leaderboard))
    return true;
  else
    return false;
}

async function findPlayerByName(name, leaderboard) {
  if (leaderboard && !isValidLeaderboard(leaderboard))
    return null;

  const options = { };

  const matchExact = name.match(/^'(.*)'$/);
  if (matchExact) {
    name = matchExact[1];

    options.query = name;
    options.exact = true;
  } else {
    options.query = name;
  }

  if (leaderboard) {
    //const json = await fetchAOE4World('/players/autocomplete', { query: name, leaderboard: leaderboard });
    const json = await fetchAOE4World(`/leaderboards/${leaderboard}`, options);
    if (json && json.count && json.players) {
      const player = json.players[0];

      // Restructure to standard format to make things easier for formatter
      player.modes = {};
      player.modes[leaderboard] = {
        "rating": player.rating,
        "rank": player.rank,
        "streak": player.streak,
        "games_count": player.games_count,
        "wins_count": player.wins_count,
        "losses_count": player.losses_count,
        "last_game_at": player.last_game_at,
        "win_rate": player.win_rate,
        "rank_level": player.rank_level
      };
      return player;
    }
  } else {
    const json = await fetchAOE4World('/players/search', options);
    if (json && json.count && json.players) {
      const player = json.players[0];

      // Restructure to standard format to make things easier for formatter
      player.modes = player.leaderboards;
      delete player.leaderboards;
      return player;
    }
  }

  return null;
}

async function findPlayerByRank(rank, leaderboard) {
  if (!isValidLeaderboard(leaderboard))
    return null;

  if (rank < 0) {
    return null;
  }

  if (rank == 0) {
    return {
      name: 'Twitch Chat',
      modes: {
        [leaderboard]: {
          "rating": 9999,
          "rank": 0,
          "games_count": 0,
          "rank_level": leaderboard == 'rm_1v1' ? 'conqueror_4' : null
        }
      }
    };
  }

  const page = 1 + Math.floor((rank - 1) / 50);
  const json = await fetchAOE4World(`/leaderboards/${leaderboard}`, { page: page });

  if (json && json.count && json.players) {
    const player = json.players.filter(v => v.rank == rank)[0];
    if (player) {
      // Restructure to standard format to make things easier for formatter
      player.modes = {
        [leaderboard]: {
          "rating": player.rating,
          "rank": player.rank,
          "streak": player.streak,
          "games_count": player.games_count,
          "wins_count": player.wins_count,
          "losses_count": player.losses_count,
          "last_game_at": player.last_game_at,
          "win_rate": player.win_rate,
          "rank_level": player.rank_level
        }
      };
      return player;
    }
  }

  return null;
}

async function findPlayerByQuery(query, leaderboard) {
  if (query[0] == '#') {
    const rank = parseInt(query.substring(1));
    return await findPlayerByRank(rank, leaderboard);
  } else {
    return await findPlayerByName(query, leaderboard);
  }
}

async function getPlayer(profileId) {
  if (!Number.isInteger(profileId)) return null;

  const json = await fetchAOE4World(`/players/${profileId}`);

  if (json)
  {
    // Restructure to standard format
    const match = json;

    return match;
  }

  return null;
}

async function getPlayerGames(profileId) {
  if (!Number.isInteger(profileId)) return null;

  const json = await fetchAOE4World(`/players/${profileId}/games`);

  if (json && json.games)
  {
    const games = json.games;

    return games;
  }

  return null;
}

async function fetchPlayerGames(profileId, opponentProfileId, since, page) {
  const options = { page: page };
  if (opponentProfileId) {
    options.opponent_profile_id = opponentProfileId;
  }
  if (since) {
    options.since = new Date(since).toISOString();
  }
  const json = await fetchAOE4World(`/players/${profileId}/games`, options);

  if (json) {
    json.profile_id = profileId;
    json.opponent_profile_id = opponentProfileId;
    json.index = 0;
  }

  return json;
}

async function* enumPlayerGames(profileIds, opponentProfileId, since) {
  if (!Array.isArray(profileIds))
    profileIds = [ profileIds ];
  if (profileIds.filter(p => !Number.isInteger(p)).length) return null;
  if (opponentProfileId && !Number.isInteger(opponentProfileId)) return null;

  // Fetch the initial page of each playerId
  var states = await Promise.all(profileIds.map(p => fetchPlayerGames(p, opponentProfileId, since, 1)));

  while (true) {
    // Check which states to fetch new pages for
    for (var i = 0; i < states.length; i++) {
      var s = states[i];
      if (s.index >= s.games.length && (s.offset + s.index) < s.total_count) {
        states[i] = await fetchPlayerGames(s.profile_id, opponentProfileId, since, s.page + 1);
      }
    }

    // Find out which state has the earliest game
    var firstState = states.reduce((prev, s) => {
      if (s.index >= s.games.length) {
        return prev;
      }

      if (!prev) {
        return s;
      }

      if (Date.parse(prev.games[prev.index].started_at) < Date.parse(s.games[s.index].started_at)) {
        return s;
      }

      return prev;
    }, null);

    // Break if we don't have any games left
    if (!firstState)
      break;

    // Return one game
    yield firstState.games[firstState.index];

    firstState.index += 1;
  }
}

async function getLastMatch(profileId) {
  if (!Number.isInteger(profileId)) return null;

  const json = await fetchAOE4World(`/players/${profileId}/games/last`);

  if (json)
  {
    // Restructure to standard format
    const match = json;

    return match;
  }

  return null;
}

module.exports = {
  findPlayerByName,
  findPlayerByRank,
  findPlayerByQuery,
  getPlayer,
  getPlayerGames,
  enumPlayerGames,
  getLastMatch
};
