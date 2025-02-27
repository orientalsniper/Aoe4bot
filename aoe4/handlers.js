
const aoe4 = require('./api');
const metadata = require('./metadata');
const { getFormatter } = require('./formatters');

function parseTimespan(number, suffix) {
  if (suffix.match(/^(h|hour|hours)$/)) {
    return number;
  } else if (suffix.match(/^(d|day|days)$/)) {
    return number * 24;
  } else if (suffix.match(/^(w|wk|wks|week|weeks)$/)) {
    return number * 24 * 7;
  } else if (suffix.match(/^(m|month|months)$/)) {
    return number * 24 * 30;  // Approx. don't make me do calendar checks
  } else if (suffix.match(/^(y|year|years)$/)) {
    return number * 24 * 365; // Approx. don't make me do calendar checks
  }

  return null;
}

// idletime is the session idle time, defaults to 4 * 3600 seconds. timespan overrides that and is an absolute interval in seconds.
async function getPlayerWinRate(player, options) {
  let { opponent, map, civ, idletime, timespan, includeTeamGames } = (options || {
    idletime: 4 * 3600,
    includeTeamGames: false });
  const playerProfileIds = Array.isArray(player) ? player.map(p => p.profile_id) : [ player.profile_id ];
  const opponentProfileId = opponent?.profile_id;
  const since = timespan ? Date.now() - timespan * 1000 : null;

  // Get the games iterator, which will fetch new pages as needed and multiplex profiles.
  // Note, only filter by opponent if we had a start date, otherwise we need all games to be able to detect session start.
  var gamesEnumerator = await aoe4.enumPlayerGames(playerProfileIds, since ? opponentProfileId : null, since);
  var games = await gamesEnumerator;

  const stats = {
    player:  Array.isArray(player) ? player[0] : player,
    opponent: opponent,
    timespan: timespan,
    idletime: idletime,
    games_count: 0,
    wins_count: 0,
    losses_count: 0,
    first_game_at: 0,
    last_game_at: 0,
    win_rate: 100,
    duration: 0
  };

  var now = Date.now();
  var lastgame = 0;
  var pendingGames = 0;
  var pendingGame = null;

  for await (const game of games) {

    var gametime = Date.parse(game.started_at);

    if (!timespan) {
      if (lastgame && (lastgame - gametime) > idletime * 1000)
        break;
    } else {
      if ((now - gametime) > timespan * 1000)
        break;
    }

    lastgame = gametime;

    // Ignore any 2v2 games in the winrate calculation
    const numPlayers = game.teams.flat().length;
    if (numPlayers > 2 && !includeTeamGames) {
      continue;
    }

    var playerState = null;
    var opponentState = null;

    for (const team of game.teams) {
      const teamPlayer = team.filter(p => playerProfileIds.includes(p.player.profile_id))[0]?.player;
      const teamOpponent = opponent ? team.filter(p => p.player.profile_id == opponent.profile_id)[0]?.player : null;

      if (teamPlayer)
        playerState = teamPlayer;
      else if (teamOpponent) // Note this also filters out games where the player and opponent are in the same team
        opponentState = teamOpponent;
    }

    if (!playerState) {
      continue;
    }

    if (opponent && !opponentState) {
      continue;
    }

    // Skip ongoing games in the calculation
    if (!game.duration) {

      // Only track pending games in the last 3 hours (due to old canceled games)
      if (Date.parse(game.started_at) > (now - 3 * 3600 * 1000)) {
        if (!pendingGame) {
          pendingGame = game;
        }
        pendingGames += 1;
      }

      continue;
    }

    if (civ && playerState.civilization != civ) {
      continue;
    }

    if (map && game.map != map) {
      continue;
    }

    if (!stats.last_game_at) {
      stats.last_game_at = new Date(Date.parse(game.started_at) + (game.duration || 0) * 1000).toISOString();
    }
    stats.first_game_at = game.started_at;
    stats.games_count += 1;
    stats.duration += (game.duration || 0);

    if (playerState.result == "win") {
      stats.wins_count += 1;
    } else if (playerState.result == "loss") {
      stats.losses_count += 1;
    }
  }

  stats.pending_games = pendingGames;
  if (pendingGame) {
    stats.pending_game_started_at = pendingGame.started_at;
  }

  if (stats.losses_count) {
    stats.win_rate = Math.round(1000 * stats.wins_count / (stats.wins_count + stats.losses_count)) / 10;
  }

  return stats;
}

// Description: match returns the last completed ladder game of a particular player
// Notes: Match supports multiple players to be specified as default. Allowing a streamer to have it auto-pick the last match from any of their alts with '&player=12345,89438'.
// Query Params:
// query        rank '#1' or player name 'xyz' to search for
// player       Serves as default player identifier of 'query' is empty. comma separated list of profile_ids, the latest game for any of the specified profiles is used.
// leaderboard  Specifies on which leaderboard to search for the user. 'rm_1v1'/'qm_1v1'/etc
// format       Specifies the format of the output, defaults to json. 'nightbot' is a text output for twitch chat.
async function handleAoe4Match(req, res) {
  const query = req.query.query || '';
  const leaderboard = req.query.leaderboard;
  const format = req.query.format;
  const players = [];
  if (query.length) {
    const player = await aoe4.findPlayerByQuery(query, leaderboard || 'rm_1v1');
    if (player && player.profile_id) {
      players.push(player.profile_id);
    }
  } else if (req.query.player) {
    players.push(...req.query.player.split(',').map(v => parseInt(v)));
  }

  const formatter = getFormatter(format);

  if (!formatter) {
    res.status(400).send('Invalid formatter specified');
    return;
  }

  if (players.length) {
    // Get last match for all player IDs
    const matches = await Promise.all(players.map(p => aoe4.getLastMatch(p, leaderboard)));

    // Get the most recent one
    const match = matches.filter(v => v !== null).sort((a,b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0];

    if (match) {
      formatter.sendMatch(match, res);
    } else {
      const player = await aoe4.getPlayer(players[0]);
      formatter.sendError(`"${player.name}" has no matches`, res);
    }
  } else {
    formatter.sendError('No player found', res);
  }
}

// Description: rank returns the rank and rating of the specified player & leaderboard
// Query Params:
// query        rank '#1' or player name 'xyz' to search for
// player       Serves as default player identifier of 'query' is empty. Must be single profile_id.
// leaderboard  Specifies on which leaderboard to search for the user, and rank/elo from that ladder is used in formatting. 'rm_1v1'/'qm_1v1'/etc
// format       Specifies the format of the output, defaults to json. 'nightbot' is a text output for twitch chat.
async function handleAoe4Rank(req, res) {
  const query = req.query.query || '';
  const leaderboard = req.query.leaderboard || 'rm_1v1';
  const format = req.query.format;
  const playerId = parseInt(req.query.player || '0');
  var player = null;
  if (query.length) {
    player = await aoe4.findPlayerByQuery(query, leaderboard);
  } else if (req.query.player) {
    player = await aoe4.getPlayer(playerId);
  }

  const formatter = getFormatter(format);

  if (!formatter) {
    res.status(400).send('Invalid formatter specified');
    return;
  }

  if (player) {
    formatter.sendRank(player, leaderboard, res);
  } else {
    formatter.sendError('No player found', res);
  }
}

// Description: Winrate returns the winrate in the last gaming session for this particular player or versus.
// Query Params:
// query        rank '#1' or player name 'xyz' to search for. Can also be 'vs xyz'(default vs opponent) or 'abc vs xyz' (one player vs other)
// player       Serves as default player identifier of 'query' is empty. Must be single profile_id.
// leaderboard  Specifies on which leaderboard to search for the user. (Note: this won't filter matches)
// format       Specifies the format of the output, defaults to json. 'nightbot' is a text output for twitch chat.
async function handleAoe4WinRate(req, res) {
  var query = req.query.query || '';
  const leaderboard = req.query.leaderboard;
  const format = req.query.format;
  let options = {
    opponent: null,
    civ: null,
    map: null,
    timespan: null,
    idletime: (4 * 3600)
  };

  if (req.query.timespan === 'season') {
    options.season = metadata.seasons[metadata.seasons.length - 1];
    options.timespan = (Date.now() - options.season.started_at) / 1000;
  } else if (req.query.timespan !== undefined) {
    options.timespan = parseInt(req.query.timespan) * 3600;
  }

  if (req.query.idletime !== undefined) {
    options.idletime = parseInt(req.query.idletime) * 3600;
  }

  const formatter = getFormatter(format);

  if (!formatter) {
    res.status(400).send('Invalid formatter specified');
    return;
  }

  var player = null;
  var match = null;
  if (query.length && (match = query.match(/^(?:(.+?) )?last (\d+) ?([a-z]+)$/))) {
    // Handle the 'last x days' suffix
    query = match[1] || '';
    options.timespan = parseTimespan(match[2], match[3]) * 3600;
    if (options.timespan === null) {
      formatter.sendError('Invalid timespan specified', res);
      return;
    }
  }
  if (query.length && (match = query.match(/^(?:(.+?) )?last (session|season)$/))) {
    // Handle the 'last session/season' suffix
    query = match[1] || '';
    if (match[2] == 'session') {
      // Clear url query parameter value
      options.season = null;
      options.timespan = null;
    } else if (match[2] == 'season') {
      options.season = metadata.seasons[metadata.seasons.length - 1];
      options.timespan = (Date.now() - options.season.started_at) / 1000;
    }
  }
  if (query.length && (match = query.match(/^(?:(.+?) )?on (\w+)$/))) {
    // Handle the 'on [map]' suffix
    query = match[1] || '';
    options.map = metadata.parseMap(match[2])?.name;
    if (options.map == null) {
      formatter.sendError('Invalid map specified', res);
      return;
    }
  }
  if (query.length && (match = query.match(/^(?:(.+?) )?with (\w+)$/))) {
    // Handle the 'with [civ]' suffix
    query = match[1] || '';
    options.civ = metadata.parseCiv(match[2])?.id;
    if (options.civ == null) {
      formatter.sendError('Invalid civ specified', res);
      return;
    }
  }
  if (query.length) {
    var versus = query.split(/ ?vs /);
    if (versus.length == 2 && versus[1].length) {
      if (versus[0].length) {
        // "abc vs def"
        player = [ await aoe4.findPlayerByQuery(versus[0], leaderboard) ];
      } else if (req.query.player) {
        // "vs def"
        // Atm we only need the full data for the first profile
        const profileIds = req.query.player.split(',').map(v => parseInt(v));
        player = [ await aoe4.getPlayer(profileIds[0]), ...profileIds.slice(1).map(p => { return { profile_id: p }}) ];
      }
      options.opponent = await aoe4.findPlayerByQuery(versus[1], leaderboard);
      if (!options.opponent) {
        formatter.sendError('No player found for opponent', res);
        return;
      }
    } else {
      player = [ await aoe4.findPlayerByQuery(query, leaderboard) ];
    }
  } else if (req.query.player) {
    // Atm we only need the full data for the first profile
    const profileIds = req.query.player.split(',').map(v => parseInt(v));
    player = [ await aoe4.getPlayer(profileIds[0]), ...profileIds.slice(1).map(p => { return { profile_id: p }}) ];
  }

  if (player.length && player[0]) {
    const winrate = await getPlayerWinRate(player, options);
    if (winrate) {
      winrate.player = player[0];
      winrate.options = options;
      formatter.sendWinRate(winrate, res);
    } else {
      formatter.sendError('No winrate available', res);
    }
  } else {
    formatter.sendError('No player found', res);
  }
}

module.exports = {
  handleAoe4Match,
  handleAoe4Rank,
  handleAoe4WinRate
};
