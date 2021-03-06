/**
 * Copyright 2016 Google Inc. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

// Modules imports
const functions = require('firebase-functions');
const rp = require('request-promise');

// Firebase Setup
const admin = require('firebase-admin');
const serviceAccount = require('./service-account.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// Generate a Request option to access LINE APIs
function generateLineApiRequest(apiEndpoint, lineAccessToken) {
  return {
    url: apiEndpoint,
    headers: {
      'Authorization': `Bearer ${lineAccessToken}`,
    },
    json: true,
  };
}

/**
 * Look up Firebase user based on LINE's mid. If the Firebase user does not exist,
 * fetch LINE profile and create a new Firebase user with it.
 *
 * @returns {Promise<UserRecord>} The Firebase user record in a promise.
 */
async function getFirebaseUser(lineMid, lineAccessToken) {
  // Generate Firebase user's uid based on LINE's mid
  const firebaseUid = `line:${lineMid}`;

  // LINE's get user profile API endpoint
  const getProfileOptions = generateLineApiRequest('https://api.line.me/v1/profile', lineAccessToken);

  try {
    const response = await admin.auth().getUser(firebaseUid);
    // Parse user profile from LINE's get user profile API response
    const displayName = response.displayName;
    const photoURL = response.pictureUrl;

    console.log('Create new Firebase user for LINE user mid = "', lineMid, '"');
    // Create a new Firebase user with LINE profile and return it
    return admin.auth().createUser({
      uid: firebaseUid,
      displayName: displayName,
      photoURL: photoURL,
    });
  } catch(error) {
    // If user does not exist, fetch LINE profile and create a Firebase new user with it
    if (error.code === 'auth/user-not-found') {
      return rp(getProfileOptions);
    }
    // If error other than auth/user-not-found occurred, fail the whole login process
    throw error;
  }
}

/**
 * Verify LINE access token and return a custom auth token allowing signing-in
 * the corresponding Firebase account.
 *
 * Here are the steps involved:
 *  1. Verify with LINE server that a LINE access token is valid
 *  2. Check if a Firebase user corresponding to the LINE user already existed.
 *  If not, fetch user profile from LINE and generate a corresponding Firebase user.
 *  3. Return a custom auth token allowing signing-in the Firebase account.
 *
 * @returns {Promise<string>} The Firebase custom auth token in a promise.
 */
async function verifyLineToken(lineAccessToken) {
  // Send request to LINE server for access token verification
  const verifyTokenOptions = generateLineApiRequest('https://api.line.me/v1/oauth/verify', lineAccessToken);

  // STEP 1: Verify with LINE server that a LINE access token is valid
  const response = await rp(verifyTokenOptions);
  // Verify the token???s channelId match with my channelId to prevent spoof attack
  // <IMPORTANT> As LINE's Get user profiles API response doesn't include channelID,
  // you must not skip this step to make sure that the LINE access token is indeed
  // issued for your channel.
  // TODO: consider !== here
  if (response.channelId !== functions.config().line.channelid) {
    throw new Error('LINE channel ID mismatched');
  }

  // STEP 2: Access token validation succeeded, so look up the corresponding Firebase user
  const lineMid = response.mid;
  const userRecord = await getFirebaseUser(lineMid, lineAccessToken);
  // STEP 3: Generate Firebase Custom Auth Token
  const token = await admin.auth().createCustomToken(userRecord.uid);
  console.log('Created Custom token for UID "', userRecord.uid, '" Token:', token);
  return token;
}

// Verify LINE token and exchange for Firebase Custom Auth token
exports.verifyToken = functions.https.onRequest(async (req, res) => {
  if (req.body.token === undefined) {
    const ret = {
      error_message: 'Access Token not found',
    };
    return res.status(400).send(ret);
  }

  const reqToken = req.body.token;

  try {
    // Verify LINE access token with LINE server then generate Firebase Custom Auth token
    const customAuthToken = await verifyLineToken(reqToken);
    const ret = {
      firebase_token: customAuthToken,
    };
    return res.status(200).send(ret);
  } catch(err) {
    // If LINE access token verification failed, return error response to client
    const ret = {
      error_message: 'Authentication error: Cannot verify access token.',
    };
    console.error('LINE token verification failed: ', err);
    return res.status(403).send(ret);
  }
});
