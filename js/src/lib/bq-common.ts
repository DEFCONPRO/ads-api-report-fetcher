/**
 * Copyright 2023 Google LLC
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

import { BigQuery, Dataset } from "@google-cloud/bigquery";
import bigquery from "@google-cloud/bigquery/build/src/types";
import {getLogger} from "./logger";

export var OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/cloud-platform.read-only",
  "https://www.googleapis.com/auth/bigquery",
  "https://www.googleapis.com/auth/bigquery.readonly",
];

export async function getDataset(
    bigquery: BigQuery,
    datasetId: string,
    datasetLocation?: string
  ): Promise<Dataset> {
    let dataset: Dataset;
    const options: bigquery.IDataset = {
      location: datasetLocation,
    };
    try {
      dataset = bigquery.dataset(datasetId, options);
      await dataset.get({ autoCreate: true });
    } catch (e) {
      const logger = getLogger();
      logger.error(`Failed to get or create the dataset ${datasetId}`);
      throw e;
    }
    return dataset;
  }
