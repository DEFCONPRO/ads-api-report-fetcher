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

import _ from 'lodash';
const ads_protos = require('google-ads-node/build/protos/protos.json');
import logger from './logger';
import {Customizer, CustomizerType, FieldType, FieldTypeKind, isEnumType, ProtoTypeMeta, QueryElements, ResourceInfo} from './types';
import { substituteMacros } from './utils';

const protoRoot = ads_protos.nested.google.nested.ads.nested.googleads.nested;
const protoVer = Object.keys(protoRoot)[0];  // e.g. "v9"
const protoRowType = protoRoot[protoVer].nested.services.nested.GoogleAdsRow;
const protoResources = protoRoot[protoVer].nested.resources.nested;
const protoEnums = protoRoot[protoVer].nested.enums.nested;
const protoCommonTypes = protoRoot[protoVer].nested.common.nested;

export class AdsQueryEditor {
  /**
   * Remove comments and empty lines, normilize newlines.
   */
  private cleanupQueryText(query: string): string {
    let queryLines = [];
    for (let line of query.split('\n')) {
      // lines that start with '#' are treated as comments
      if (line.startsWith('#') || line.trim() == '') {
        continue;
      }
      // remove comments, we support '--' and '//' as comment line starters
      line = line.replace(/(\-\-|\/\/)(.*)/g, '').trim();
      if (line.length > 0) queryLines.push(line);
    }
    query = queryLines.join('\n\r');
    query = '' + query.replace(/\s{2,}/g, ' ');
    return query;
  }

  private parseFunctions(query: string): Record<string, Function> {
    let match = query.match(/FUNCTIONS (.*)/i);
    let functions: Record<string, Function> = {};
    if (match && match.length > 1) {
      let code = match[1];
      let iter = code.matchAll(/function\s+([^(]+)\s*\(\s*([^)]+)\s*\)\s*\{/ig);
      for (let funcBlock of iter) {
        let funcName = funcBlock[1];
        let argName = funcBlock[2];
        let idx = funcBlock[0].length;
        let brackets = 1;
        for (let i = idx; i < code.length; i++) {
          if (code[i] === '{')
            brackets++;
          else if (code[i] === '}')
            brackets--;
          if (brackets === 0) {
            // found the closing '}' of the function body, cut off the body w/o
            // enclosing {}
            let funcBody = code.slice(idx, i - 1);
            try {
              functions[funcName] = new Function(argName, funcBody);
            } catch (e) {
              logger.error(`InvalidQuerySyntax: failed to parse '${
                  funcName}' function's body:\n ${e}`);
              throw e;
            }
            break;
          }
        }
      }
    }
    return functions;
  }

  parseQuery(query: string, macros?: Record<string, any>): QueryElements {
    query = this.cleanupQueryText(query);
    let queryNormalized = this.normalizeQuery(query, macros || {});
    let selectFields = query.replace(/(^\s*SELECT)|(\s*FROM .*)/gi, '')
                           .split(',')
                           .filter(function(field) {
                             return field.length > 0;
                           });

    let functions = this.parseFunctions(query);
    let field_index = 0
    let fields: string[] = [];
    let column_names: string[] = [];
    let customizers: Array<Customizer|null> = [];
    for (let item of selectFields) {
      let pair = item.trim().toLowerCase().split(/ as /);
      let select_expr = pair[0];
      let alias = pair[1];  // can be undefined
      let parsedExpr = this.parseExpression(select_expr);
      customizers[field_index] = parsedExpr.customizer || null;
      if (!parsedExpr.field || !parsedExpr.field.trim()) {
        throw new Error(
            `IncorrectQuerySyntax: empty select field at index ${field_index}`);
      }
      fields.push(parsedExpr.field);
      // fields.push(this.format_type_field_name(parsed_expr.field_name))
      let column_name = alias || parsedExpr.field.replace(/\./, '_');
      column_name = column_name.replace(/[ ]/g, '');
      // check for uniquniess
      if (column_names.includes(column_name)) {
        throw new Error(`InvalidQuerySyntax: duplicating column name ${
            column_name} at index ${field_index}`);
      }
      column_names.push(column_name);

      field_index++;
    }

    // parse query metadata (resource type)
    let match = query.match(/ FROM ([^\s]+)/i);
    if (!match || !match.length)
      throw new Error(`Could not parse resource from the query`);
    let resourceName = match[1];
    let resourceTypeFrom = this.getResource(resourceName)
    if (!resourceTypeFrom) throw new Error(`Could not find resource ${
        resourceName} specified in FROM in protobuf schema`);
    let resourceInfo: ResourceInfo = {
      name: resourceName,
      typeName: resourceTypeFrom.name,
      typeMeta: resourceTypeFrom,
      isConstant: resourceName.endsWith('_constant')
    };

    // initialize columns types
    let columnTypes = [];
    for (let i = 0; i < fields.length; i++) {
      let field = fields[i];
      let nameParts = field.split('.');
      let curType = this.getResource(nameParts[0]);
      let fieldType = this.getFieldType(curType, nameParts.slice(1));

      let customizer = customizers[i];
      if (customizer) {
        if (customizer.type === CustomizerType.NestedField) {
          // we expect a field with nested_field customizer should ends with a
          // type (not primitive, not enum) i.e. ProtoTypeMeta
          if (_.isString(fieldType.type)) {
            throw new Error(`InvalidQuery: field ${
                field} contains nested field accessor (:) but selected field's type is primitive (${
                fieldType.typeName})`);
          }
          if (isEnumType(fieldType.type)) {
            throw new Error(`InvalidQuery: field ${
                field} contains nested field accessor (:) but selected field's type enum (${
                fieldType.typeName})`);
          }
          let repeated = fieldType.repeated;
          fieldType =
              this.getFieldType(fieldType.type, customizer.selector.split('.'));
          fieldType.repeated = repeated || fieldType.repeated;
        } else if (customizer.type === CustomizerType.ResourceIndex) {
          fieldType.typeName = 'int64';
          fieldType.type = 'int64';
          fieldType.kind = FieldTypeKind.primitive;
        } else if (customizer.type === CustomizerType.Function) {
          // expect that function's return type is always string
          // TODO: we could explicitly tell the type in query, e.g.
          // "field:$fun<int> AS field"
          fieldType.type = 'string';
          fieldType.typeName = 'string';
          fieldType.kind = FieldTypeKind.primitive;
          // TODO: we could support functions that return arrays or scalar
          // but how to tell it in a query ? e.g. field:$fun<int,string[]>
          // Currently all columns with functions are treated as scalar
          fieldType.repeated = false;
        }
      }
      columnTypes.push(fieldType);
    }

    return new QueryElements(
        queryNormalized, fields, column_names, customizers, resourceInfo,
        columnTypes, functions);
    /*
    // for (let line of query_lines) {
    //   // exclude SELECT keyword
    //   if (line.toUpperCase().startsWith('SELECT')) continue;
    //   // exclude everything that goes after FROM statement
    //   if (line.toUpperCase().startsWith('FROM')) {
    //     break;
    //   }
    //   let pair = line.split(/ [Aa][Ss] /);
    //   let select_expr = pair[0];
    //   let alias = pair[1];  // can be undefined
    //   let parsed_expr = this.parseExpression(select_expr);
    //   customizers[field_index] = parsed_expr.customizer_type ? {
    //     type: parsed_expr.customizer_type,
    //     value: parsed_expr.customizer_value
    //   } : null;
    //   parsed_expr.field_name = parsed_expr.field_name.replace(/[, ]/g, '');
    //   fields.push(parsed_expr.field_name);
    //   // fields.push(this.format_type_field_name(parsed_expr.field_name))
    //   let column_name = alias || parsed_expr.field_name;
    //   column_name = column_name.replace(/[, ]/g, '');
    //   column_names.push(column_name);

    //   field_index += 1
    // }
    */
  }

  resourcesMap: Record<string, any> = {};

  primitiveTypes = ['string', 'int64', 'int32', 'float', 'double', 'bool'];

  private getFieldType(type: ProtoTypeMeta, nameParts: string[]): FieldType {
    if (!nameParts || !nameParts.length)
      throw new Error('ArgumentException: namePart should be empty');

    for (let i = 0; i < nameParts.length; i++) {
      let fieldType: FieldType;
      let field = type.fields[nameParts[i]];
      let repeated = field.rule === 'repeated';
      let isLastPart = i === nameParts.length - 1;
      if (repeated && !isLastPart) {
        throw new Error(`InternalError: repeated field '${
            nameParts[i]}' in the middle of prop chain '${
            nameParts.join('.')}'`);
      }
      let fieldTypeName = field.type;
      // is it a primitive type?
      if (this.primitiveTypes.includes(fieldTypeName)) {
        fieldType = {
          repeated,
          type: fieldTypeName,
          typeName: fieldTypeName,
          kind: FieldTypeKind.primitive
        };
        // field with primitive type can be only at the end of property chain
        if (!isLastPart) {
          throw new Error(
              `InternalError: field '${nameParts[i]}' in prop chain '${
                  nameParts.join('.')}' has primitive type ${fieldTypeName}`);
        }
        return fieldType;
      }
      // is it a link to common type or enum
      else if (fieldTypeName.startsWith(
                   `google.ads.googleads.${protoVer}.enums.`)) {
        // google.ads.googleads.v9.enums
        // e.g. "google.ads.googleads.v9.enums.CriterionTypeEnum.CriterionType"
        let match = fieldTypeName.match(
            /google\.ads\.googleads\.v[\d]+\.enums\.([^\.]+)\.([^\.]+)/i);
        if (!match || match.length < 3) {
          throw new Error(`Could parse enum type reference ${fieldTypeName}`);
        }
        let enumType = protoEnums[match[1]].nested[match[2]];
        enumType['name'] = match[2];
        fieldType = {
          repeated,
          type: enumType,
          typeName: match[2],
          kind: FieldTypeKind.enum
        };
        // field with primitive type can be only at the end of property chain
        if (!isLastPart) {
          throw new Error(
              `InternalError: field '${nameParts[i]}' in prop chain '${
                  nameParts.join('.')}' has enum type ${fieldTypeName}`);
        }
        return fieldType;
      } else if (fieldTypeName.startsWith(
                     `google.ads.googleads.${protoVer}.common.`)) {
        // google.ads.googleads.v9.common
        let match = fieldTypeName.match(
            /google\.ads\.googleads\.v[\d]+\.common\.([^\.]+)/i);
        if (!match || match.length < 2) {
          throw new Error(`Could parse common type reference ${fieldTypeName}`);
        }
        let commonType = protoCommonTypes[match[1]];
        commonType['name'] = match[1];

        fieldType = {
          repeated,
          type: commonType,
          typeName: match[1],
          kind: FieldTypeKind.struct
        };
      } else {
        // then it's either another resource or a nested type
        if (type.nested && type.nested[fieldTypeName]) {
          fieldType = {
            repeated,
            type: type.nested[fieldTypeName],
            typeName: fieldTypeName,
            kind: FieldTypeKind.struct
          };
        } else if (protoResources[fieldTypeName]) {
          fieldType = {
            repeated,
            type: protoResources[fieldTypeName],
            typeName: fieldTypeName,
            kind: FieldTypeKind.struct
          };
        } else if (protoCommonTypes[fieldTypeName]) {
          // yes, some fields refer to common types by a full name but some by a
          // short one
          fieldType = {
            repeated,
            type: protoCommonTypes[fieldTypeName],
            typeName: fieldTypeName,
            kind: FieldTypeKind.struct
          };
        } else {
          throw new Error(`InternalError: could not find a type proto for ${
              fieldTypeName} (field ${nameParts})`)
        }
      }
      type = <ProtoTypeMeta>fieldType.type;
      if (isLastPart) return fieldType;
    }
    throw new Error('InternalError');
  }

  private getResource(fieldName: string): ProtoTypeMeta&{name: string} {
    let resourceType = this.resourcesMap[fieldName];
    if (resourceType) return resourceType;
    let resource = protoRowType.fields[fieldName];
    if (!resource)
      throw new Error(
          `Could not find resource '${fieldName}' in protobuf schema`);
    // resource.type will be a full name like
    // "google.ads.googleads.v9.resources.AdGroup" or
    // "google.ads.googleads.v9.common.Metrics"
    // we need to get the last part and  find such a resource in
    let nameParts = resource.type.split('.');
    let resourceTypeName = nameParts[nameParts.length - 1];
    if (resource.type.startsWith(
            `google.ads.googleads.${protoVer}.resources.`)) {
      resourceType = protoResources[resourceTypeName];
    } else if (resource.type.startsWith(
                   `google.ads.googleads.${protoVer}.common.`)) {
      resourceType = protoCommonTypes[resourceTypeName];
    }
    if (!resourceType) {
      throw new Error(`InternalError: could find resource ${resourceTypeName}`);
    }
    this.resourcesMap[fieldName] = resourceType;
    resourceType['name'] = resourceTypeName;
    return resourceType;
  }

  parseExpression(selectExpr: string):
      {field: string, customizer?: Customizer} {
    let resources = selectExpr.split('~');
    if (resources.length > 1) {
      if (!_.isInteger(+resources[1])) {
        throw new Error(`Expression '${
            selectExpr}' contains indexed access ('~') but argument isn't a number`);
      }
      return {
        field: resources[0],
        customizer: {type: CustomizerType.ResourceIndex, index: +resources[1]}
      };
    }
    let nestedFields = selectExpr.split(':');
    if (nestedFields.length > 1) {
      let value = nestedFields[1];
      if (!value) {
        throw new Error(`Expression '${
            selectExpr}' contains nested path (':') but path is empty`);
      }
      if (value.startsWith('$')) {
        // the value is a function
        return {
          field: nestedFields[0],
          customizer: {type: CustomizerType.Function, function: value.slice(1)}
        };
      }
      return {
        field: nestedFields[0],
        customizer: {type: CustomizerType.NestedField, selector: value}
      };
    }
    return {field: selectExpr};
  }

  normalizeQuery(query: string, macros: Record<string, any>): string {
    query = this.removeAliases(query)
    query = this.removeCustomizers(query)
    // remove section FUNCTIONS
    query = query.replace(/FUNCTIONS .*/gi, '');
    // cut off the last comma (after last column before FROM)
    query = query.replace(/,\s*FROM /gi, ' FROM ');
    // parse parameters and detected unspecified ones
    let res = substituteMacros(query, macros);
    if (res.unknown_params.length) {
      throw new Error(
          `The following parameters used in query and were not specified: ` +
          res.unknown_params);
    }
    return res.queryText;
  }

  private removeAliases(query: string): string {
    return query.replace(/\s+[Aa][Ss]\s+(\w+)/g, '');
  }

  private removeCustomizers(query: string): string {
    return query.replace(/->(\w+)|->/g, '')
        .replace(/~(\w+)|->/g, '')
        .replace(/:([^\s,]|$)+/g, '');
  }
}
