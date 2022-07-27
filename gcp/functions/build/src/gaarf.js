"use strict";
/**
 * Copyright 2022 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.main = void 0;
const fs_1 = __importDefault(require("fs"));
const google_ads_api_report_fetcher_1 = require("google-ads-api-report-fetcher");
const path_1 = __importDefault(require("path"));
const main = async (req, res) => {
    console.log(req.query);
    console.log(req.body);
    // prepare Ads API parameters
    let adsConfig;
    let adsConfigFile = process.env.ADS_CONFIG || 'google-ads.yaml';
    if (fs_1.default.existsSync(adsConfigFile)) {
        adsConfig = (0, google_ads_api_report_fetcher_1.loadAdsConfigYaml)(adsConfigFile, req.query.customer_id);
    }
    else {
        adsConfig = {
            developer_token: process.env.DEVELOPER_TOKEN,
            login_customer_id: process.env.LOGIN_CUSTOMER_ID,
            client_id: process.env.CLIENT_ID,
            client_secret: process.env.CLIENT_SECRET,
            refresh_token: process.env.REFRESH_TOKEN
        };
    }
    console.log('Ads API config:');
    console.log(adsConfig);
    if (!adsConfig.developer_token || !adsConfig.refresh_token) {
        throw new Error(`Ads API configuration is not complete.`);
    }
    let projectId = req.query.project_id || process.env.PROJECT_ID;
    if (!projectId)
        throw new Error(`Project id is not specified in either 'project_id' query argument or PROJECT_ID envvar`);
    let dataset = req.query.dataset || process.env.DATASET;
    if (!dataset)
        throw new Error(`Dataset is not specified in either 'dataset' query argument or DATASET envvar`);
    let customerId = req.query.customer_id || adsConfig.customer_id;
    if (!customerId)
        throw new Error(`Customer id is not specified in either 'customer_id' query argument or google-ads.yaml`);
    let ads_client = new google_ads_api_report_fetcher_1.GoogleAdsApiClient(adsConfig, customerId);
    let executor = new google_ads_api_report_fetcher_1.AdsQueryExecutor(ads_client);
    let writer = new google_ads_api_report_fetcher_1.BigQueryWriter(projectId, dataset, { keepData: true });
    // TODO: support CsvWriter and output path to GCS
    // (csv.destination_folder=gs://bucket/path)
    let singleCustomer = req.query.single_customer;
    let body = req.body || {};
    let macroParams = body.macros;
    let { queryText, scriptName } = await getScript(req);
    let customers;
    if (singleCustomer) {
        console.log('Executing for a single customer ids: ' + customerId);
        customers = [customerId];
    }
    else {
        console.log('Fetching customer ids');
        customers = await ads_client.getCustomerIds();
        console.log(`Customers to process (${customers.length}):`);
        console.log(customers);
    }
    await executor.execute(scriptName, queryText, customers, macroParams, writer);
    // we're returning a map of customer to number of rows
    let result = Object.entries(writer.rowsByCustomer).map(p => {
        return { [p[0]]: p[1].length };
    });
    res.send(result);
};
exports.main = main;
async function getScript(req) {
    let scriptPath = req.query.script_path;
    let body = req.body || {};
    let queryText;
    let scriptName;
    if (body.script) {
        queryText = body.query;
        scriptName = body.name;
        console.log(`Executing inline Ads-query from request`);
    }
    else {
        queryText = await (0, google_ads_api_report_fetcher_1.getFileContent)(scriptPath);
        scriptName = path_1.default.basename(scriptPath).split('.sql')[0];
        console.log(`Executing Ads-query from '${scriptPath}'`);
    }
    if (!queryText)
        throw new Error(`Ads script was not specified in either script_path query argument or body.query`);
    if (!scriptName)
        throw new Error(`Could not determine script name`);
    return { queryText, scriptName };
}
//# sourceMappingURL=gaarf.js.map