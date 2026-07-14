const path = require('path');
const { google } = require('googleapis');

const KEY_PATH = path.join(__dirname, 'sheetsimporter.json');
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function authorize() {
  const auth = new google.auth.GoogleAuth({ keyFile: KEY_PATH, scopes: SCOPES });
  return auth.getClient();
}

module.exports = { authorize };
