/**
 * Script to block a list of screen names using credentials for a given user id
 */
var twitterAPI = require('node-twitter-api'),
    fs = require('fs'),
    _ = require('sequelize').Utils._,
    setup = require('./setup');

var twitter = setup.twitter,
    logger = setup.logger,
    BtUser = setup.BtUser,
    UnblockedUser = setup.UnblockedUser,
    Action = setup.Action;

/**
 * Given a list of uids, enqueue them all in the Actions table.
 *
 * TODO: Once all the actions are created, this should kick off a processing run
 * for the triggering user. Need to figure out how to do Promise joins.
 *
 * @param{string} source_uid The user who wants to perform these actions.
 * @param{string[]} list A list of uids to target with the actions.
 */
function queueBlocks(source_uid, list) {
  list.map(function(sink_uid) {
    return Action.create({
      source_uid: source_uid,
      sink_uid: sink_uid,
      type: "block"
    }).error(function(err) {
      logger.error(err);
    });
  });
}

/**
 * Find all pending block actions in the queue, validate and execute them.
 *
 * Validation is a little tricky.  We want to check whether a given
 * user is blocking the target. The relevant endpoint is friendships/lookup,
 * https://dev.twitter.com/docs/api/1.1/get/friendships/lookup.
 * That endpoint has a rate limit of 15 requests per 15 minutes, which means
 * bulk blocking would proceed very slowly if we called it once per block
 * action.
 *
 * However, friendships/lookup supports bulk querying of up to 100 users at
 * once. So we organize the validation by source_uid. In short: for every BtUser
 * in the database, get up to 100 of their oldest pending blocks, ask Twitter
 * (in bulk) whether the source_uid follows the sink_uid, and if not then 
 * proceed with the blocks. Note that the block endpoint can only block one user
 * at a time, but it does not appear to have a rate limit.
 *
 * When a block action is completed, set its state to DONE. When a block
 * action is cancelled because the source_uid follows the sink_uid, set its
 * state to CANCELLED_FOLLOWING.
 */
function processBlocks() {
  BtUser
    .findAll()
    .error(function(err) {
      logger.error(err);
    }).success(function(btUsers) {
      // Note that we can't call processActionsForUser directly here. We need to
      // send it through processActionsForUserId to pick up the Actions.
      btUsers.forEach(function(btUser) {
        processActionsForUserId(btUser.uid);
      });
    })
}

/**
 * For a given user id, fetch and process pending actions.
 * @param{string} uid The uid of the user to process.
 */
function processActionsForUserId(uid) {
  BtUser
    .find({
      where: { uid: uid },
      include: [{
        model: Action,
        // Out of the available pending block actions on this user,
        // pick up to 100 with the earliest updatedAt times.
        where: [ 'status = "pending" and type = "block"' ],
        order: 'updatedAt ASC',
        limit: 100
      },
      UnblockedUser]
    }).error(function(err) {
      logger.error(err);
    }).success(function(btUser) {
      // Since we include Actions above, we'll get a null btUser if the uesr we
      // are looking for has no actions.
      if (btUser) {
        processActionsForUser(btUser);
      }
    })
}

/**
 * Given a BtUser that has a number of Actions preloaded, process those actions
 * as appropriate.
 * @param{BtUser} btUser The user whose attached Actions we should process.
 */
function processActionsForUser(btUser) {
  var actionsToCheck = btUser.actions;
  if (actionsToCheck.length > 0) {
    // Now that we've got our list, send them to Twitter to see if the
    // btUser follows them.
    var sinkUids = actionsToCheck.map(function(action) {
      return action.sink_uid;
    })
    blockUnlessFollowing(btUser, sinkUids, actionsToCheck);
  }
}

/**
 * Given fewer that 100 sinkUids, check the following relationship between
 * sourceBtUser and those each sinkUid, and block if there is not an existing
 * follow or block relationship. Then update the Actions provided.
 *
 * @param{BtUser} sourceBtUser The user doing the blocking.
 * @param{integer[]} sinkUids A list of uids to potentially block.
 * @param{Action[]} actions The Actions to be updated based on the results.
 */
function blockUnlessFollowing(sourceBtUser, sinkUids, actions) {
  if (sinkUids.length > 100) {
    logger.error('No more than 100 sinkUids allowed. Given', sinkUids.length);
    return;
  }
  var unblockedUids = sourceBtUser.unblockedUsers.map(function(uu) {
    return uu.sink_uid;
  });
  logger.debug('Checking follow status ', sourceBtUser.uid,
    ' --???--> ', sinkUids);
  twitter.friendships("lookup", {
      user_id: sinkUids.join(',')
    }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
    function (err, results) {
      if (err) {
        logger.error(err);
      } else {
        results.forEach(function(friendship) {
          var conns = friendship.connections;
          var sink_uid = friendship.id_str;
          var newState = null;
          if (_.contains(conns, 'blocking')) {
            newState = Action.CANCELLED_DUPLICATE;
          } else if (_.contains(conns, 'following')) {
            newState = Action.CANCELLED_FOLLOWING;
          } else if (sourceBtUser.uid === sink_uid) {
            newState = Action.CANCELLED_SELF;
          } else if (_.contains(unblockedUids, sink_uid)) {
            // If the user unblocked the sink_uid in the past, don't re-block.
            newState = Action.CANCELLED_UNBLOCKED;
          }
          // If we're cancelling, update the state of the action. It's
          // possible to have multiple pending Blocks for the same sink_uid, so
          // we have to do a forEach across the available Actions.
          if (newState) {
            setActionsStatus(sink_uid, actions, newState);
          } else {
            // No obstacles to blocking the sink_uid have been found, block 'em!
            twitter.blocks("create", {
                user_id: sink_uid,
                skip_status: 1
              }, sourceBtUser.access_token, sourceBtUser.access_token_secret,
              function(err, results) {
                if (err) {
                  logger.error("Error blocking: %j", err);
                } else {
                  logger.info("Blocked " + results.screen_name);
                  setActionsStatus(sink_uid, actions, Action.DONE);
                }
              });
          }
        });
      }
    });
}

/**
 * For every action whose sink_uid matches the provided one, set the action's
 * status to `newState', and save it.
 */
function setActionsStatus(sink_uid, actions, newState) {
  actions.forEach(function(action) {
    if (sink_uid === action.sink_uid) {
      action.status = newState;
      action.save().error(function (err) {
        logger.error(err);
      });
    }
  })
}

module.exports = {
  queueBlocks: queueBlocks,
  processActionsForUserId: processActionsForUserId
};

if (require.main === module) {
  // TODO: It's possible for one run of processBlocks could take more than 10
  // seconds, in which case we wind up with multiple instances running
  // concurrently. This probably won't happen since each run only processes 100
  // items per user, but with a lot of users it could, and would lead to some
  // redundant work as each instance tried to grab work from a previous
  // instance. Figure out a way to prevent this while being robust (i.e. not
  // having to make sure every possible code path calls a finishing callback).
  processBlocks();
  setInterval(processBlocks, 10 * 1000);
}
