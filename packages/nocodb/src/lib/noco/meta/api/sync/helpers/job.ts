import FetchAT from './fetchAT';
import { UITypes } from 'nocodb-sdk';
// import * as sMap from './syncMap';
import FormData from 'form-data';

import { Api } from 'nocodb-sdk';

import axios from 'axios';
import Airtable from 'airtable';
import jsonfile from 'jsonfile';
import hash from 'object-hash';

export default async (
  syncDB: AirtableSyncConfig,
  progress: (msg: string) => void
) => {
  const sMap = {
    mapTbl: {},

    // static mapping records between aTblId && ncId
    addToMappingTbl(aTblId, ncId, ncName, parent?) {
      this.mapTbl[aTblId] = {
        ncId: ncId,
        ncParent: parent,
        // name added to assist in quick debug
        ncName: ncName
      };
    },

    // get NcID from airtable ID
    getNcIdFromAtId(aId) {
      return this.mapTbl[aId]?.ncId;
    },

    // get nc Parent from airtable ID
    getNcParentFromAtId(aId) {
      return this.mapTbl[aId]?.ncParent;
    },

    // get nc-title from airtable ID
    getNcNameFromAtId(aId) {
      return this.mapTbl[aId]?.ncName;
    }
  };

  let base, baseId;
  const start = Date.now();
  const enableErrorLogs = false;
  const process_aTblData = true;
  const generate_migrationStats = true;
  const debugMode = true;
  let api: Api<any>;
  let g_aTblSchema = [];
  let ncCreatedProjectSchema: any = {};
  const ncLinkMappingTable: any[] = [];
  const aTblDataLinks: any[] = [];
  const nestedLookupTbl: any[] = [];
  const nestedRollupTbl: any[] = [];
  const runTimeCounters = {
    sort: 0,
    filter: 0,
    view: {
      total: 0,
      grid: 0,
      gallery: 0,
      form: 0
    },
    fetchAt: {
      count: 0,
      time: 0
    }
  };

  let syncLog = _log => {
    // console.log(log)
  };

  // mapping table
  //

  async function getAtableSchema(sDB) {
    const start = Date.now();
    const ft = await FetchAT(sDB.shareId);
    const duration = Date.now() - start;
    runTimeCounters.fetchAt.count++;
    runTimeCounters.fetchAt.time += duration;

    const file = ft.schema;
    baseId = ft.baseId;
    base = new Airtable({ apiKey: sDB.apiKey }).base(baseId);
    // store copy of atbl schema globally
    g_aTblSchema = file.tableSchemas;

    if (debugMode) jsonfile.writeFileSync('aTblSchema.json', ft, { spaces: 2 });

    return file;
  }

  async function getViewData(shareId, tblId, viewId) {
    const start = Date.now();
    const ft = await FetchAT(shareId, tblId, viewId);
    const duration = Date.now() - start;
    runTimeCounters.fetchAt.count++;
    runTimeCounters.fetchAt.time += duration;

    if (debugMode) jsonfile.writeFileSync(`${viewId}.json`, ft, { spaces: 2 });
    return ft.schema?.tableDatas[0]?.viewDatas[0];
  }

  // base mapping table
  const aTblNcTypeMap = {
    foreignKey: UITypes.LinkToAnotherRecord,
    text: UITypes.SingleLineText,
    multilineText: UITypes.LongText,
    multipleAttachment: UITypes.Attachment,
    checkbox: UITypes.Checkbox,
    multiSelect: UITypes.MultiSelect,
    select: UITypes.SingleSelect,
    collaborator: UITypes.Collaborator,
    multiCollaborator: UITypes.Collaborator,
    date: UITypes.Date,
    // kludge: phone: UITypes.PhoneNumber,
    phone: UITypes.SingleLineText,
    number: UITypes.Number,
    rating: UITypes.Rating,
    // kludge: formula: UITypes.Formula,
    formula: UITypes.SingleLineText,
    rollup: UITypes.Rollup,
    count: UITypes.Count,
    lookup: UITypes.Lookup,
    autoNumber: UITypes.AutoNumber,
    barcode: UITypes.Barcode,
    button: UITypes.Button
  };

  //-----------------------------------------------------------------------------
  // aTbl helper routines
  //

  // aTbl: retrieve table name from table ID
  //
  function aTbl_getTableName(tblId) {
    const sheetObj = g_aTblSchema.find(tbl => tbl.id === tblId);
    return {
      tn: sheetObj.name
    };
  }

  const ncSchema = {
    tables: [],
    tablesById: {}
  };

  // aTbl: retrieve column name from column ID
  //
  function aTbl_getColumnName(colId): any {
    for (let i = 0; i < g_aTblSchema.length; i++) {
      const sheetObj = g_aTblSchema[i];
      const column = sheetObj.columns.find(col => col.id === colId);
      if (column !== undefined)
        return {
          tn: sheetObj.name,
          cn: column.name
        };
    }
  }

  // nc dump schema
  //
  // @ts-ignore
  async function nc_DumpTableSchema() {
    console.log('[');
    const ncTblList = await api.dbTable.list(ncCreatedProjectSchema.id);
    for (let i = 0; i < ncTblList.list.length; i++) {
      const ncTbl = await api.dbTable.read(ncTblList.list[i].id);
      console.log(JSON.stringify(ncTbl, null, 2));
      console.log(',');
    }
    console.log(']');
  }

  // retrieve nc column schema from using aTbl field ID as reference
  //
  async function nc_getColumnSchema(aTblFieldId) {
    // let ncTblList = await api.dbTable.list(ncCreatedProjectSchema.id);
    // let aTblField = aTbl_getColumnName(aTblFieldId);
    // let ncTblId = ncTblList.list.filter(x => x.title === aTblField.tn)[0].id;
    // let ncTbl = await api.dbTable.read(ncTblId);
    // let ncCol = ncTbl.columns.find(x => x.title === aTblField.cn);
    // return ncCol;

    const ncTblId = sMap.getNcParentFromAtId(aTblFieldId);
    const ncColId = sMap.getNcIdFromAtId(aTblFieldId);

    // not migrated column, skip
    if (ncColId === undefined || ncTblId === undefined) return 0;

    const ncCol = ncSchema.tablesById[ncTblId].columns.find(
      x => x.id === ncColId
    );
    return ncCol;
  }

  // retrieve nc table schema using table name
  // optimize: create a look-up table & re-use information
  //
  async function nc_getTableSchema(tableName) {
    // let ncTblList = await api.dbTable.list(ncCreatedProjectSchema.id);
    // let ncTblId = ncTblList.list.filter(x => x.title === tableName)[0].id;
    // let ncTbl = await api.dbTable.read(ncTblId);
    // return ncTbl;

    return ncSchema.tables.find(x => x.title === tableName);
  }

  // delete project if already exists
  async function init({
    projectName
  }: {
    projectName?: string;
    projectId?: string;
  }) {
    // delete 'sample' project if already exists
    const x = await api.project.list();

    const sampleProj = x.list.find(a => a.title === projectName);
    if (sampleProj) {
      await api.project.delete(sampleProj.id);
    }
    syncLog('Init');
  }

  // map UIDT
  //
  function getNocoType(col) {
    // start with default map
    let ncType = aTblNcTypeMap[col.type];

    // types email & url are marked as text
    // types currency & percent, duration are marked as number
    // types createTime & modifiedTime are marked as formula

    switch (col.type) {
      case 'text':
        if (col.typeOptions?.validatorName === 'email') ncType = UITypes.Email;
        else if (col.typeOptions?.validatorName === 'url') ncType = UITypes.URL;
        break;

      case 'number':
        // kludge: currency validation error with decimal places
        if (col.typeOptions?.format === 'percentV2') ncType = UITypes.Percent;
        else if (col.typeOptions?.format === 'duration')
          ncType = UITypes.Duration;
        else if (col.typeOptions?.format === 'currency')
          ncType = UITypes.Currency;
        break;

      case 'formula':
        if (col.typeOptions?.formulaTextParsed === 'CREATED_TIME()')
          ncType = UITypes.CreateTime;
        else if (col.typeOptions?.formulaTextParsed === 'LAST_MODIFIED_TIME()')
          ncType = UITypes.LastModifiedTime;
        break;

      case 'computation':
        if (col.typeOptions?.resultType === 'collaborator')
          ncType = UITypes.Collaborator;
        break;

      // case 'barcode':
      // case 'button':
      //   ncType = UITypes.SingleLineText;
      //   break;
    }

    return ncType;
  }

  // retrieve additional options associated with selected data types
  //
  function getNocoTypeOptions(col: any): any {
    switch (col.type) {
      case 'select':
      case 'multiSelect': {
        // prepare options list in CSV format
        // note: NC doesn't allow comma's in options
        //
        const opt = [];
        for (const [, value] of Object.entries(col.typeOptions.choices)) {
          opt.push((value as any).name);
          sMap.addToMappingTbl(
            (value as any).id,
            undefined,
            (value as any).name
          );
        }
        const csvOpt = "'" + opt.join("','") + "'";
        return { type: 'select', data: csvOpt };
      }
      default:
        return { type: undefined };
    }
  }

  // convert to Nc schema (basic, excluding relations)
  //
  function tablesPrepare(tblSchema: any[]) {
    const tables: any[] = [];

    for (let i = 0; i < tblSchema.length; ++i) {
      const table: any = {};

      syncLog(`Preparing base schema (sans relations): ${tblSchema[i].name}`);
      runTimeCounters.view.total += tblSchema[i].views.length;

      // Enable to use aTbl identifiers as is: table.id = tblSchema[i].id;
      table.table_name = tblSchema[i].name;
      table.title = tblSchema[i].name;

      // insert _aTbl_nc_rec_id of type ID by default
      table.columns = [
        {
          title: '_aTbl_nc_rec_id',
          column_name: '_aTbl_nc_rec_id',
          // uidt: UITypes.ID
          uidt: UITypes.SingleLineText,
          pk: true,
          // mysql additionally requires NOT-NULL to be explicitly set
          rqd: true
        },
        {
          title: '_aTbl_nc_rec_hash',
          column_name: '_aTbl_nc_rec_hash',
          uidt: UITypes.SingleLineText
        }
      ];

      for (let j = 0; j < tblSchema[i].columns.length; j++) {
        const col = tblSchema[i].columns[j];

        // skip link, lookup, rollup fields in this iteration
        if (['foreignKey', 'lookup', 'rollup'].includes(col.type)) {
          continue;
        }

        // not supported datatype
        if (['formula'].includes(col.type)) continue;

        // base column schema
        // kludge: error observed in Nc with space around column-name
        const ncCol: any = {
          // Enable to use aTbl identifiers as is: id: col.id,
          title: col.name.trim(),

          // knex complains use of '?' in field name
          // good to replace all special characters by _ in one go
          column_name: col.name
            .replace(/\?/g, 'QQ')
            .replace('.', '_')
            .trim(),
          uidt: getNocoType(col)
        };

        // check if already a column exists with same name?
        const duplicateColumn = table.columns.find(
          x => x.title === col.name.trim()
        );
        if (duplicateColumn) {
          if (enableErrorLogs) console.log(`## Duplicate ${ncCol.title}`);

          ncCol.title = ncCol.title + '_2';
          ncCol.column_name = ncCol.column_name + '_2';
        }

        // additional column parameters when applicable
        const colOptions = getNocoTypeOptions(col);

        switch (colOptions.type) {
          case 'select':
            ncCol.dtxp = colOptions.data;
            break;

          case undefined:
            break;
        }
        table.columns.push(ncCol);
      }
      tables.push(table);
    }
    return tables;
  }

  async function nocoCreateBaseSchema(aTblSchema) {
    // base schema preparation: exclude
    const tables: any[] = tablesPrepare(aTblSchema);

    syncLog(`Total tables: ${tables.length} `);

    // for each table schema, create nc table
    for (let idx = 0; idx < tables.length; idx++) {
      syncLog(
        `[${idx + 1}/${tables.length}] Creating base table schema: ${
          tables[idx].title
        }`
      );

      syncLog(`NC API: dbTable.create ${tables[idx].title}`);
      const table: any = await api.dbTable.create(
        ncCreatedProjectSchema.id,
        tables[idx]
      );
      updateNcTblSchema(table);

      // update mapping table
      await sMap.addToMappingTbl(aTblSchema[idx].id, table.id, table.title);
      for (let colIdx = 0; colIdx < table.columns.length; colIdx++) {
        const aId = aTblSchema[idx].columns.find(
          x => x.name.trim() === table.columns[colIdx].title
        )?.id;
        if (aId)
          await sMap.addToMappingTbl(
            aId,
            table.columns[colIdx].id,
            table.columns[colIdx].title,
            table.id
          );
      }

      // update default view name- to match it to airtable view name
      syncLog(`NC API: dbView.list ${table.id}`);
      const view = await api.dbView.list(table.id);

      syncLog(
        `NC API: dbView.update ${view.list[0].id} ${aTblSchema[idx].views[0].name}`
      );
      const aTbl_grid = aTblSchema[idx].views.find(x => x.type === 'grid');
      // @ts-ignore
      const x = await api.dbView.update(view.list[0].id, {
        title: aTbl_grid.name
      });
      await updateNcTblSchemaById(table.id);

      await sMap.addToMappingTbl(
        aTbl_grid.id,
        table.views[0].id,
        aTbl_grid.name,
        table.id
      );
    }

    // debug
    // console.log(JSON.stringify(tables, null, 2));
    return tables;
  }

  async function nocoCreateLinkToAnotherRecord(aTblSchema) {
    // Link to another RECORD
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      const aTblLinkColumns = aTblSchema[idx].columns.filter(
        x => x.type === 'foreignKey'
      );

      // Link columns exist
      //
      if (aTblLinkColumns.length) {
        for (let i = 0; i < aTblLinkColumns.length; i++) {
          syncLog(
            `[${idx + 1}/${aTblSchema.length}] Configuring Links :: [${i + 1}/${
              aTblLinkColumns.length
            }] ${aTblSchema[idx].name}`
          );

          // for self links, there is no symmetric column
          {
            const src = aTbl_getColumnName(aTblLinkColumns[i].id);
            const dst = aTbl_getColumnName(
              aTblLinkColumns[i].typeOptions?.symmetricColumnId
            );
            syncLog(
              `    LTAR ${src.tn}:${src.cn} <${aTblLinkColumns[i].typeOptions.relationship}> ${dst?.tn}:${dst?.cn}`
            );
          }

          // check if link already established?
          if (!nc_isLinkExists(aTblLinkColumns[i].id)) {
            // parent table ID
            // let srcTableId = (await nc_getTableSchema(aTblSchema[idx].name)).id;
            const srcTableId = sMap.getNcIdFromAtId(aTblSchema[idx].id);

            // find child table name from symmetric column ID specified
            // self link, symmetricColumnId field will be undefined
            const childTable = aTbl_getColumnName(
              aTblLinkColumns[i].typeOptions?.symmetricColumnId
            );

            // retrieve child table ID (nc) from table name
            let childTableId = srcTableId;
            if (childTable) {
              childTableId = (await nc_getTableSchema(childTable.tn)).id;
            }

            // check if already a column exists with this name?
            const srcTbl: any = await api.dbTable.read(srcTableId);
            const duplicate = srcTbl.columns.find(
              x => x.title === aTblLinkColumns[i].name
            );
            const suffix = duplicate ? '_2' : '';
            if (duplicate)
              if (enableErrorLogs)
                console.log(`## Duplicate ${aTblLinkColumns[i].name}`);

            // create link
            const ncTbl: any = await api.dbTableColumn.create(srcTableId, {
              uidt: UITypes.LinkToAnotherRecord,
              title: aTblLinkColumns[i].name + suffix,
              parentId: srcTableId,
              childId: childTableId,
              type: 'mm'
              // aTblLinkColumns[i].typeOptions.relationship === 'many'
              //   ? 'mm'
              //   : 'hm'
            });
            updateNcTblSchema(ncTbl);
            syncLog(`NC API: dbTableColumn.create LinkToAnotherRecord`);

            const ncId = ncTbl.columns.find(
              x => x.title === aTblLinkColumns[i].name + suffix
            )?.id;
            await sMap.addToMappingTbl(
              aTblLinkColumns[i].id,
              ncId,
              aTblLinkColumns[i].name + suffix,
              ncTbl.id
            );

            // store link information in separate table
            // this information will be helpful in identifying relation pair
            const link = {
              nc: {
                title: aTblLinkColumns[i].name,
                parentId: srcTableId,
                childId: childTableId,
                type: 'mm'
              },
              aTbl: {
                tblId: aTblSchema[idx].id,
                ...aTblLinkColumns[i]
              }
            };

            ncLinkMappingTable.push(link);
          } else {
            // if link already exists, we need to change name of linked column
            // to what is represented in airtable

            // 1. extract associated link information from link table
            // 2. retrieve parent table information (source)
            // 3. using foreign parent & child column ID, find associated mapping in child table
            // 4. update column name
            const x = ncLinkMappingTable.findIndex(
              x =>
                x.aTbl.tblId ===
                  aTblLinkColumns[i].typeOptions.foreignTableId &&
                x.aTbl.id === aTblLinkColumns[i].typeOptions.symmetricColumnId
            );

            const childTblSchema: any = await api.dbTable.read(
              ncLinkMappingTable[x].nc.childId
            );
            const parentTblSchema: any = await api.dbTable.read(
              ncLinkMappingTable[x].nc.parentId
            );

            // fix me
            // let childTblSchema = ncSchema.tablesById[ncLinkMappingTable[x].nc.childId]
            // let parentTblSchema = ncSchema.tablesById[ncLinkMappingTable[x].nc.parentId]

            let parentLinkColumn = parentTblSchema.columns.find(
              col => col.title === ncLinkMappingTable[x].nc.title
            );

            // hack // fix me
            if (parentLinkColumn.uidt !== 'LinkToAnotherRecord') {
              parentLinkColumn = parentTblSchema.columns.find(
                col => col.title === ncLinkMappingTable[x].nc.title + '_2'
              );
            }

            let childLinkColumn: any = {};

            if (parentLinkColumn.colOptions.type == 'hm') {
              // for hm:
              // mapping between child & parent column id is direct
              //
              childLinkColumn = childTblSchema.columns.find(
                col =>
                  col.uidt === UITypes.LinkToAnotherRecord &&
                  col.colOptions.fk_child_column_id ===
                    parentLinkColumn.colOptions.fk_child_column_id &&
                  col.colOptions.fk_parent_column_id ===
                    parentLinkColumn.colOptions.fk_parent_column_id
              );
            } else {
              // for mm:
              // mapping between child & parent column id is inverted
              //
              childLinkColumn = childTblSchema.columns.find(
                col =>
                  col.uidt === UITypes.LinkToAnotherRecord &&
                  col.colOptions.fk_child_column_id ===
                    parentLinkColumn.colOptions.fk_parent_column_id &&
                  col.colOptions.fk_parent_column_id ===
                    parentLinkColumn.colOptions.fk_child_column_id &&
                  col.colOptions.fk_mm_model_id ===
                    parentLinkColumn.colOptions.fk_mm_model_id
              );
            }

            // check if already a column exists with this name?
            const duplicate = childTblSchema.columns.find(
              x => x.title === aTblLinkColumns[i].name
            );
            const suffix = duplicate ? '_2' : '';
            if (duplicate)
              if (enableErrorLogs)
                console.log(`## Duplicate ${aTblLinkColumns[i].name}`);

            // rename
            // note that: current rename API requires us to send all parameters,
            // not just title being renamed
            const ncTbl: any = await api.dbTableColumn.update(
              childLinkColumn.id,
              {
                ...childLinkColumn,
                title: aTblLinkColumns[i].name + suffix
              }
            );
            updateNcTblSchema(ncTbl);

            const ncId = ncTbl.columns.find(
              x => x.title === aTblLinkColumns[i].name + suffix
            )?.id;
            await sMap.addToMappingTbl(
              aTblLinkColumns[i].id,
              ncId,
              aTblLinkColumns[i].name + suffix,
              ncTbl.id
            );

            // console.log(res.columns.find(x => x.title === aTblLinkColumns[i].name))
            syncLog(`NC API: dbTableColumn.update rename symmetric column`);
          }
        }
      }
    }
  }

  async function nocoCreateLookups(aTblSchema) {
    // LookUps
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      const aTblColumns = aTblSchema[idx].columns.filter(
        x => x.type === 'lookup'
      );

      // parent table ID
      // let srcTableId = (await nc_getTableSchema(aTblSchema[idx].name)).id;
      const srcTableId = sMap.getNcIdFromAtId(aTblSchema[idx].id);

      if (aTblColumns.length) {
        // Lookup
        for (let i = 0; i < aTblColumns.length; i++) {
          syncLog(
            `[${idx + 1}/${aTblSchema.length}] Configuring Lookup :: [${i +
              1}/${aTblColumns.length}] ${aTblSchema[idx].name}`
          );

          // something is not right, skip
          if (
            aTblColumns[i]?.typeOptions?.dependencies?.invalidColumnIds?.length
          ) {
            if (enableErrorLogs)
              console.log(`## Invalid column IDs mapped; skip`);
            continue;
          }

          const ncRelationColumnId = sMap.getNcIdFromAtId(
            aTblColumns[i].typeOptions.relationColumnId
          );
          const ncLookupColumnId = sMap.getNcIdFromAtId(
            aTblColumns[i].typeOptions.foreignTableRollupColumnId
          );

          if (ncLookupColumnId === undefined) {
            aTblColumns[i]['srcTableId'] = srcTableId;
            nestedLookupTbl.push(aTblColumns[i]);
            continue;
          }

          const ncTbl: any = await api.dbTableColumn.create(srcTableId, {
            uidt: UITypes.Lookup,
            title: aTblColumns[i].name,
            fk_relation_column_id: ncRelationColumnId,
            fk_lookup_column_id: ncLookupColumnId
          });
          updateNcTblSchema(ncTbl);

          const ncId = ncTbl.columns.find(x => x.title === aTblColumns[i].name)
            ?.id;
          await sMap.addToMappingTbl(
            aTblColumns[i].id,
            ncId,
            aTblColumns[i].name,
            ncTbl.id
          );

          syncLog(`NC API: dbTableColumn.create LOOKUP`);
        }
      }
    }

    let level = 2;
    let nestedCnt = 0;
    while (nestedLookupTbl.length) {
      // if nothing has changed from previous iteration, skip rest
      if (nestedCnt === nestedLookupTbl.length) {
        if (enableErrorLogs)
          console.log(
            `## Failed to configure ${nestedLookupTbl.length} lookups`
          );
        break;
      }

      // Nested lookup
      nestedCnt = nestedLookupTbl.length;
      for (let i = 0; i < nestedLookupTbl.length; i++) {
        syncLog(
          `Configuring Nested Lookup: Level-${level} [${i + 1}/${nestedCnt}]`
        );

        const srcTableId = nestedLookupTbl[i].srcTableId;

        const ncRelationColumnId = sMap.getNcIdFromAtId(
          nestedLookupTbl[i].typeOptions.relationColumnId
        );
        const ncLookupColumnId = sMap.getNcIdFromAtId(
          nestedLookupTbl[i].typeOptions.foreignTableRollupColumnId
        );

        if (ncLookupColumnId === undefined) {
          continue;
        }

        const ncTbl: any = await api.dbTableColumn.create(srcTableId, {
          uidt: UITypes.Lookup,
          title: nestedLookupTbl[i].name,
          fk_relation_column_id: ncRelationColumnId,
          fk_lookup_column_id: ncLookupColumnId
        });
        updateNcTblSchema(ncTbl);

        const ncId = ncTbl.columns.find(
          x => x.title === nestedLookupTbl[i].name
        )?.id;
        await sMap.addToMappingTbl(
          nestedLookupTbl[i].id,
          ncId,
          nestedLookupTbl[i].name,
          ncTbl.id
        );

        // remove entry
        nestedLookupTbl.splice(i, 1);
        syncLog(`NC API: dbTableColumn.create LOOKUP`);
      }
      level++;
    }
  }

  async function nocoCreateRollups(aTblSchema) {
    // Rollups
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      const aTblColumns = aTblSchema[idx].columns.filter(
        x => x.type === 'rollup'
      );

      // parent table ID
      // let srcTableId = (await nc_getTableSchema(aTblSchema[idx].name)).id;
      const srcTableId = sMap.getNcIdFromAtId(aTblSchema[idx].id);

      if (aTblColumns.length) {
        // rollup exist
        for (let i = 0; i < aTblColumns.length; i++) {
          syncLog(
            `[${idx + 1}/${aTblSchema.length}] Configuring Rollup :: [${i +
              1}/${aTblColumns.length}] ${aTblSchema[idx].name}`
          );

          // something is not right, skip
          if (
            aTblColumns[i]?.typeOptions?.dependencies?.invalidColumnIds?.length
          ) {
            if (enableErrorLogs)
              console.log(`## Invalid column IDs mapped; skip`);
            continue;
          }

          const ncRelationColumnId = sMap.getNcIdFromAtId(
            aTblColumns[i].typeOptions.relationColumnId
          );
          const ncRollupColumnId = sMap.getNcIdFromAtId(
            aTblColumns[i].typeOptions.foreignTableRollupColumnId
          );

          if (ncRollupColumnId === undefined) {
            aTblColumns[i]['srcTableId'] = srcTableId;
            nestedRollupTbl.push(aTblColumns[i]);
            continue;
          }

          const ncTbl: any = await api.dbTableColumn.create(srcTableId, {
            uidt: UITypes.Rollup,
            title: aTblColumns[i].name,
            fk_relation_column_id: ncRelationColumnId,
            fk_rollup_column_id: ncRollupColumnId,
            rollup_function: 'sum' // fix me: hardwired
          });
          updateNcTblSchema(ncTbl);
          syncLog(`NC API: dbTableColumn.create ROLLUP`);

          const ncId = ncTbl.columns.find(x => x.title === aTblColumns[i].name)
            ?.id;
          await sMap.addToMappingTbl(
            aTblColumns[i].id,
            ncId,
            aTblColumns[i].name,
            ncTbl.id
          );
        }
      }
    }
    syncLog(`Nested rollup: ${nestedRollupTbl.length}`);
  }

  async function nocoLookupForRollups() {
    const nestedCnt = nestedLookupTbl.length;
    for (let i = 0; i < nestedLookupTbl.length; i++) {
      syncLog(`Configuring Lookup over Rollup :: [${i + 1}/${nestedCnt}]`);

      const srcTableId = nestedLookupTbl[i].srcTableId;

      const ncRelationColumnId = sMap.getNcIdFromAtId(
        nestedLookupTbl[i].typeOptions.relationColumnId
      );
      const ncLookupColumnId = sMap.getNcIdFromAtId(
        nestedLookupTbl[i].typeOptions.foreignTableRollupColumnId
      );

      if (ncLookupColumnId === undefined) {
        continue;
      }

      const ncTbl: any = await api.dbTableColumn.create(srcTableId, {
        uidt: UITypes.Lookup,
        title: nestedLookupTbl[i].name,
        fk_relation_column_id: ncRelationColumnId,
        fk_lookup_column_id: ncLookupColumnId
      });
      updateNcTblSchema(ncTbl);

      // remove entry
      nestedLookupTbl.splice(i, 1);
      syncLog(`NC API: dbTableColumn.create LOOKUP`);

      const ncId = ncTbl.columns.find(x => x.title === nestedLookupTbl[i].name)
        ?.id;
      await sMap.addToMappingTbl(
        nestedLookupTbl[i].id,
        ncId,
        nestedLookupTbl[i].name,
        ncTbl.id
      );
    }
  }

  async function nocoSetPrimary(aTblSchema) {
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      syncLog(
        `[${idx + 1}/${aTblSchema.length}] Configuring Primary value : ${
          aTblSchema[idx].name
        }`
      );

      const pColId = aTblSchema[idx].primaryColumnId;
      const ncColId = sMap.getNcIdFromAtId(pColId);

      // skip primary column configuration if we field not migrated
      syncLog(`NC API: dbTableColumn.primaryColumnSet`);
      if (ncColId) {
        await api.dbTableColumn.primaryColumnSet(ncColId);

        // update schema
        const ncTblId = sMap.getNcIdFromAtId(aTblSchema[idx].id);
        await updateNcTblSchemaById(ncTblId);
      }
    }
  }

  // retrieve nc-view column ID from corresponding nc-column ID
  async function nc_getViewColumnId(viewId, viewType, ncColumnId) {
    // retrieve view Info
    let viewDetails = [];

    if (viewType === 'form')
      viewDetails = (await api.dbView.formRead(viewId)).columns;
    else if (viewType === 'gallery')
      viewDetails = (await api.dbView.galleryRead(viewId)).columns;
    else viewDetails = await api.dbView.gridColumnsList(viewId);

    const viewColumnId = viewDetails.find(x => x.fk_column_id === ncColumnId)
      ?.id;

    return viewColumnId;
  }

  // @ts-ignore
  async function nc_hideColumn(tblName, viewName, hiddenColumns, viewType?) {
    // retrieve table schema
    const ncTbl = await nc_getTableSchema(tblName);
    // retrieve view ID
    const viewId = ncTbl.views.find(x => x.title === viewName).id;

    // retrieve view Info
    let viewDetails = [];

    if (viewType === 'form')
      viewDetails = (await api.dbView.formRead(viewId)).columns;
    else if (viewType === 'gallery')
      viewDetails = (await api.dbView.galleryRead(viewId)).columns;
    else viewDetails = await api.dbView.gridColumnsList(viewId);

    for (let i = 0; i < hiddenColumns.length; i++) {
      // retrieve column schema
      const ncColumn = ncTbl.columns.find(x => x.title === hiddenColumns[i]);
      // retrieve view column ID
      const viewColumnId = viewDetails.find(
        x => x.fk_column_id === ncColumn?.id
      )?.id;

      // fix me
      if (viewColumnId === undefined) {
        if (enableErrorLogs)
          console.log(
            `## Column disable fail: ${tblName}, ${viewName}, ${hiddenColumns[i]}`
          );
        continue;
      }

      // hide
      syncLog(`NC API: dbViewColumn.update ${viewId}, ${ncColumn.id}`);
      // @ts-ignore
      const retVal = await api.dbViewColumn.update(viewId, viewColumnId, {
        show: false
      });
    }
  }

  //////////  Data processing

  async function nocoLinkProcessing(projName, table, record, _field) {
    const rec = record.fields;
    const refRowIdList: any = Object.values(rec);
    const referenceColumnName = Object.keys(rec)[0];

    if (refRowIdList.length) {
      for (let i = 0; i < refRowIdList[0].length; i++) {
        syncLog(
          `NC API: dbTableRow.nestedAdd ${record.id}/mm/${referenceColumnName}/${refRowIdList[0][i]}`
        );

        await api.dbTableRow.nestedAdd(
          'noco',
          projName,
          table.id,
          `${record.id}`,
          'mm', // fix me
          encodeURIComponent(referenceColumnName),
          `${refRowIdList[0][i]}`
        );
      }
    }
  }

  // fix me:
  // instead of skipping data after retrieval, use select fields option in airtable API
  async function nocoBaseDataProcessing(sDB, table, record) {
    const recordHash = hash(record);
    const rec = record.fields;

    // kludge -
    // trim spaces on either side of column name
    // leads to error in NocoDB
    Object.keys(rec).forEach(key => {
      const replacedKey = key.replace(/\?/g, 'QQ').trim();
      if (key !== replacedKey) {
        rec[replacedKey] = rec[key];
        delete rec[key];
      }
    });

    // post-processing on the record
    for (const [key, value] of Object.entries(rec as { [key: string]: any })) {
      // retrieve datatype
      const dt = table.columns.find(x => x.title === key)?.uidt;

      // if(dt === undefined)
      //   console.log('fix me')

      // https://www.npmjs.com/package/validator
      // default value: digits_after_decimal: [2]
      // if currency, set decimal place to 2
      //
      if (dt === UITypes.Currency) rec[key] = (+value).toFixed(2);

      // we will pick up LTAR once all table data's are in place
      if (dt === UITypes.LinkToAnotherRecord) {
        aTblDataLinks.push(JSON.parse(JSON.stringify(rec)));
        delete rec[key];
      }

      // these will be automatically populated depending on schema configuration
      if (dt === UITypes.Lookup) delete rec[key];
      if (dt === UITypes.Rollup) delete rec[key];

      if (dt === UITypes.Collaborator) {
        // in case of multi-collaborator, this will be an array
        if (Array.isArray(value)) {
          let collaborators = '';
          for (let i = 0; i < value.length; i++) {
            collaborators += `${value[i]?.name} <${value[i]?.email}>, `;
            rec[key] = collaborators;
          }
        } else rec[key] = `${value?.name} <${value?.email}>`;
      }

      if (dt === UITypes.Barcode) rec[key] = value.text;
      if (dt === UITypes.Button) rec[key] = `${value?.label} <${value?.url}>`;

      if (dt === UITypes.Attachment) {
        const tempArr = [];
        for (const v of value) {
          const binaryImage = await axios
            .get(v.url, {
              responseType: 'stream',
              headers: {
                'Content-Type': v.type
              }
            })
            .then(response => {
              return response.data;
            })
            .catch(error => {
              console.log(error);
              return false;
            });

          const imageFile: any = new FormData();
          imageFile.append('files', binaryImage, {
            filename: v.filename.includes('?')
              ? v.filename.split('?')[0]
              : v.filename
          });

          const rs = await axios
            .post(sDB.baseURL + '/api/v1/db/storage/upload', imageFile, {
              params: {
                path: `noco/${sDB.projectName}/${table.title}/${key}`
              },
              headers: {
                'Content-Type': `multipart/form-data; boundary=${imageFile._boundary}`,
                'xc-auth': sDB.authToken
              }
            })
            .then(response => {
              return response.data;
            })
            .catch(e => {
              console.log(e);
            });

          tempArr.push(...rs);
        }
        rec[key] = JSON.stringify(tempArr);
      }
    }

    // insert airtable record ID explicitly into each records
    rec['_aTbl_nc_rec_id'] = record.id;
    rec['_aTbl_nc_rec_hash'] = recordHash;

    // console.log(rec)

    syncLog(`NC API: dbTableRow.bulkCreate ${table.title} [${rec}]`);
    // console.log(JSON.stringify(rec, null, 2))

    // bulk Insert
    // @ts-ignore
    const returnValue = await api.dbTableRow.bulkCreate(
      'nc',
      sDB.projectName,
      table.id, // encodeURIComponent(table.title),
      [rec]
    );
  }

  async function nocoReadData(sDB, table, callback) {
    return new Promise((resolve, reject) => {
      base(table.title)
        .select({
          pageSize: 100
          // maxRecords: 1,
        })
        .eachPage(
          async function page(records, fetchNextPage) {
            // console.log(JSON.stringify(records, null, 2));

            // This function (`page`) will get called for each page of records.
            await Promise.all(
              records.map(record => callback(sDB, table, record))
            );

            // To fetch the next page of records, call `fetchNextPage`.
            // If there are more records, `page` will get called again.
            // If there are no more records, `done` will get called.
            fetchNextPage();
          },
          function done(err) {
            if (err) {
              console.error(err);
              reject(err);
            }
            resolve(null);
          }
        );
    });
  }

  async function nocoReadDataSelected(projName, table, callback, fields) {
    return new Promise((resolve, reject) => {
      base(table.title)
        .select({
          pageSize: 100,
          // maxRecords: 100,
          fields: [fields]
        })
        .eachPage(
          async function page(records, fetchNextPage) {
            // console.log(JSON.stringify(records, null, 2));

            // This function (`page`) will get called for each page of records.
            // records.forEach(record => callback(table, record));
            await Promise.all(
              records.map(r => callback(projName, table, r, fields))
            );

            // To fetch the next page of records, call `fetchNextPage`.
            // If there are more records, `page` will get called again.
            // If there are no more records, `done` will get called.
            fetchNextPage();
          },
          function done(err) {
            if (err) {
              console.error(err);
              reject(err);
            }
            resolve(null);
          }
        );
    });
  }

  //////////

  function nc_isLinkExists(atblFieldId) {
    if (
      ncLinkMappingTable.find(
        x => x.aTbl.typeOptions.symmetricColumnId === atblFieldId
      )
    )
      return true;
    return false;
  }

  async function nocoCreateProject(projName) {
    syncLog(`Create Project: ${projName}`);

    // create empty project (XC-DB)
    ncCreatedProjectSchema = await api.project.create({
      title: projName
    });
  }

  async function nocoGetProject(projId) {
    syncLog(`Getting project meta: ${projId}`);

    // create empty project (XC-DB)
    ncCreatedProjectSchema = await api.project.read(projId);
  }

  async function nocoConfigureGalleryView(sDB, aTblSchema) {
    if (!sDB.syncViews) return;
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      const tblId = (await nc_getTableSchema(aTblSchema[idx].name)).id;
      const galleryViews = aTblSchema[idx].views.filter(
        x => x.type === 'gallery'
      );

      const configuredViews =
        runTimeCounters.view.grid +
        runTimeCounters.view.gallery +
        runTimeCounters.view.form;
      runTimeCounters.view.gallery += galleryViews.length;

      for (let i = 0; i < galleryViews.length; i++) {
        syncLog(
          `[${configuredViews + i + 1}/${
            runTimeCounters.view.total
          }] Configuring view :: Gallery`
        );
        syncLog(`   Axios fetch view-data`);

        // create view
        // @ts-ignore
        const vData = await getViewData(
          sDB.shareId,
          aTblSchema[idx].id,
          galleryViews[i].id
        );
        const viewName = aTblSchema[idx].views.find(
          x => x.id === galleryViews[i].id
        )?.name;

        syncLog(`   Create NC View :: ${viewName}`);
        // @ts-ignore
        const g = await api.dbView.galleryCreate(tblId, { title: viewName });
        await updateNcTblSchemaById(tblId);
        // syncLog(`[${idx+1}/${aTblSchema.length}][Gallery View][${i+1}/${galleryViews.length}] Create ${viewName}`)

        // await nc_configureFields(g.id, vData.columnOrder, aTblSchema[idx].name, viewName, 'gallery');
      }
    }
  }

  async function nocoConfigureFormView(sDB, aTblSchema) {
    if (!sDB.syncViews) return;
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      const tblId = sMap.getNcIdFromAtId(aTblSchema[idx].id);
      const formViews = aTblSchema[idx].views.filter(x => x.type === 'form');

      const configuredViews =
        runTimeCounters.view.grid +
        runTimeCounters.view.gallery +
        runTimeCounters.view.form;
      runTimeCounters.view.form += formViews.length;
      for (let i = 0; i < formViews.length; i++) {
        syncLog(
          `[${configuredViews + i + 1}/${
            runTimeCounters.view.total
          }] Configuring view :: Form`
        );
        syncLog(`   Axios fetch view-data`);

        // create view
        const vData = await getViewData(
          sDB.shareId,
          aTblSchema[idx].id,
          formViews[i].id
        );
        const viewName = aTblSchema[idx].views.find(
          x => x.id === formViews[i].id
        )?.name;

        // everything is default
        let refreshMode = 'NO_REFRESH';
        let msg = 'Thank you for submitting the form!';
        let desc = '';

        // response will not include form object if everything is default
        //
        if (vData.metadata?.form) {
          refreshMode = vData.metadata.form.refreshAfterSubmit;
          msg = vData.metadata.form?.afterSubmitMessage
            ? vData.metadata.form.afterSubmitMessage
            : 'Thank you for submitting the form!';
          desc = vData.metadata.form.description;
        }

        const formData = {
          title: viewName,
          heading: viewName,
          subheading: desc,
          success_msg: msg,
          submit_another_form: refreshMode.includes('REFRESH_BUTTON')
            ? true
            : false,
          show_blank_form: refreshMode.includes('AUTO_REFRESH') ? true : false
        };

        syncLog(`   Create NC View :: ${viewName}`);
        const f = await api.dbView.formCreate(tblId, formData);
        syncLog(
          `[${idx + 1}/${aTblSchema.length}][Form View][${i + 1}/${
            formViews.length
          }] Create ${viewName}`
        );

        await updateNcTblSchemaById(tblId);

        syncLog(`   Configure show/hide columns`);
        await nc_configureFields(
          f.id,
          vData.columnOrder,
          aTblSchema[idx].name,
          viewName,
          'form'
        );
      }
    }
  }

  async function nocoConfigureGridView(sDB, aTblSchema) {
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      const tblId = sMap.getNcIdFromAtId(aTblSchema[idx].id);
      const gridViews = aTblSchema[idx].views.filter(x => x.type === 'grid');

      const configuredViews =
        runTimeCounters.view.grid +
        runTimeCounters.view.gallery +
        runTimeCounters.view.form;
      runTimeCounters.view.grid += gridViews.length;

      for (let i = 0; i < (sDB.syncViews ? gridViews.length : 1); i++) {
        syncLog(
          `[${configuredViews + i + 1}/${
            runTimeCounters.view.total
          }] Configuring view :: Grid`
        );
        syncLog(`   Axios fetch view-data`);
        // fetch viewData JSON
        const vData = await getViewData(
          sDB.shareId,
          aTblSchema[idx].id,
          gridViews[i].id
        );

        // retrieve view name & associated NC-ID
        const viewName = aTblSchema[idx].views.find(
          x => x.id === gridViews[i].id
        )?.name;
        const viewList: any = await api.dbView.list(tblId);
        const ncViewId = viewList?.list?.find(x => x.tn === viewName)?.id;

        // create view (default already created)
        if (i > 0) {
          syncLog(`   Create NC View :: ${viewName}`);
          const viewCreated = await api.dbView.gridCreate(tblId, {
            title: viewName
          });
          await updateNcTblSchemaById(tblId);
          await sMap.addToMappingTbl(
            gridViews[i].id,
            viewCreated.id,
            viewName,
            tblId
          );
          // syncLog(`[${idx+1}/${aTblSchema.length}][Grid View][${i+1}/${gridViews.length}] Create ${viewName}`)
        }

        // syncLog(`[${idx+1}/${aTblSchema.length}][Grid View][${i+1}/${gridViews.length}] Hide columns ${viewName}`)
        syncLog(`   Configure show/hide columns`);
        await nc_configureFields(
          ncViewId,
          vData.columnOrder,
          aTblSchema[idx].name,
          viewName,
          'grid'
        );

        // configure filters
        if (vData?.filters) {
          // syncLog(`[${idx+1}/${aTblSchema.length}][Grid View][${i+1}/${gridViews.length}] Configure filters ${viewName}`)
          syncLog(`   Configure filter set`);

          // skip filters if nested
          if (!vData.filters.filterSet.find(x => x?.type === 'nested')) {
            await nc_configureFilters(ncViewId, vData.filters);
          }
        }

        // configure sort
        if (vData?.lastSortsApplied?.sortSet.length) {
          // syncLog(`[${idx+1}/${aTblSchema.length}][Grid View][${i+1}/${gridViews.length}] Configure sort ${viewName}`)
          syncLog(`   Configure sort set`);
          await nc_configureSort(ncViewId, vData.lastSortsApplied);
        }
      }
    }
  }

  async function nocoAddUsers(aTblSchema) {
    const userRoles = {
      owner: 'owner',
      create: 'creator',
      edit: 'editor',
      comment: 'commenter',
      read: 'viewer',
      none: 'viewer'
    };
    const userList = aTblSchema.appBlanket.userInfoById;
    const totalUsers = Object.keys(userList).length;
    let cnt = 0;

    for (const [_key, value] of Object.entries(
      userList as { [key: string]: any }
    )) {
      syncLog(`[${++cnt}/${totalUsers}] Configuring User :: ${value.email}`);
      await api.auth.projectUserAdd(ncCreatedProjectSchema.id, {
        email: value.email,
        roles: userRoles[value.permissionLevel]
      });
    }
  }

  function updateNcTblSchema(tblSchema) {
    const tblId = tblSchema.id;

    // replace entry from array if already exists
    const idx = ncSchema.tables.findIndex(x => x.id === tblId);
    if (idx !== -1) ncSchema.tables.splice(idx, 1);
    ncSchema.tables.push(tblSchema);

    // overwrite object if it exists
    ncSchema.tablesById[tblId] = tblSchema;
  }

  async function updateNcTblSchemaById(tblId) {
    const ncTbl = await api.dbTable.read(tblId);
    updateNcTblSchema(ncTbl);
  }

  // @ts-ignore
  async function nocoReadNcSchema() {
    const tableList = await api.dbTable.list(ncCreatedProjectSchema.id);
    for (let tblCnt = 0; tblCnt < tableList.list.length; tblCnt++) {
      const tblSchema = await api.dbTable.read(tableList.list[tblCnt].id);
      updateNcTblSchema(tblSchema);
    }
  }

  ///////////////////////

  // statistics
  //
  const migrationStats = [];

  async function generateMigrationStats(aTblSchema) {
    const migrationStatsObj = {
      table_name: '',
      aTbl: {
        columns: 0,
        links: 0,
        lookup: 0,
        rollup: 0
      },
      nc: {
        columns: 0,
        links: 0,
        lookup: 0,
        rollup: 0,
        invalidColumn: 0
      }
    };
    for (let idx = 0; idx < aTblSchema.length; idx++) {
      migrationStatsObj.table_name = aTblSchema[idx].name;

      const aTblLinkColumns = aTblSchema[idx].columns.filter(
        x => x.type === 'foreignKey'
      );
      const aTblLookups = aTblSchema[idx].columns.filter(
        x => x.type === 'lookup'
      );
      const aTblRollups = aTblSchema[idx].columns.filter(
        x => x.type === 'rollup'
      );

      let invalidColumnId = 0;
      for (let i = 0; i < aTblLookups.length; i++) {
        if (
          aTblLookups[i]?.typeOptions?.dependencies?.invalidColumnIds?.length
        ) {
          invalidColumnId++;
        }
      }
      for (let i = 0; i < aTblRollups.length; i++) {
        if (
          aTblRollups[i]?.typeOptions?.dependencies?.invalidColumnIds?.length
        ) {
          invalidColumnId++;
        }
      }

      migrationStatsObj.aTbl.columns = aTblSchema[idx].columns.length;
      migrationStatsObj.aTbl.links = aTblLinkColumns.length;
      migrationStatsObj.aTbl.lookup = aTblLookups.length;
      migrationStatsObj.aTbl.rollup = aTblRollups.length;

      const ncTbl = await nc_getTableSchema(aTblSchema[idx].name);
      const linkColumn = ncTbl.columns.filter(
        x => x.uidt === UITypes.LinkToAnotherRecord
      );
      const lookup = ncTbl.columns.filter(x => x.uidt === UITypes.Lookup);
      const rollup = ncTbl.columns.filter(x => x.uidt === UITypes.Rollup);

      // all links hardwired as m2m. m2m generates additional tables per link
      // hence link/2
      migrationStatsObj.nc.columns =
        ncTbl.columns.length - linkColumn.length / 2;
      migrationStatsObj.nc.links = linkColumn.length / 2;
      migrationStatsObj.nc.lookup = lookup.length;
      migrationStatsObj.nc.rollup = rollup.length;
      migrationStatsObj.nc.invalidColumn = invalidColumnId;

      const temp = JSON.parse(JSON.stringify(migrationStatsObj));
      migrationStats.push(temp);
    }

    const columnSum = migrationStats.reduce((accumulator, object) => {
      return accumulator + object.nc.columns;
    }, 0);
    const linkSum = migrationStats.reduce((accumulator, object) => {
      return accumulator + object.nc.links;
    }, 0);
    const lookupSum = migrationStats.reduce((accumulator, object) => {
      return accumulator + object.nc.lookup;
    }, 0);
    const rollupSum = migrationStats.reduce((accumulator, object) => {
      return accumulator + object.nc.rollup;
    }, 0);

    syncLog(`Quick Stats:`);
    syncLog(`     Total Tables:   ${aTblSchema.length}`);
    syncLog(`     Total Columns:  ${columnSum}`);
    syncLog(`       Links:        ${linkSum}`);
    syncLog(`       Lookup:       ${lookupSum}`);
    syncLog(`       Rollup:       ${rollupSum}`);
    syncLog(`     Total Filters:  ${runTimeCounters.filter}`);
    syncLog(`     Total Sort:     ${runTimeCounters.sort}`);
    syncLog(`     Total Views:    ${runTimeCounters.view.total}`);
    syncLog(`       Grid:         ${runTimeCounters.view.grid}`);
    syncLog(`       Gallery:      ${runTimeCounters.view.gallery}`);
    syncLog(`       Form:         ${runTimeCounters.view.form}`);

    const duration = Date.now() - start;
    syncLog(`Migration time:      ${duration}`);
    syncLog(`Axios fetch count:   ${runTimeCounters.fetchAt.count}`);
    syncLog(`Axios fetch time:    ${runTimeCounters.fetchAt.time}`);
  }

  //////////////////////////////
  // filters

  const filterMap = {
    '=': 'eq',
    '!=': 'neq',
    '<': 'lt',
    '<=': 'lte',
    '>': 'gt',
    '>=': 'gte',
    isEmpty: 'empty',
    isNotEmpty: 'notempty',
    contains: 'like',
    doesNotContain: 'nlike',
    isAnyOf: 'eq',
    isNoneOf: 'neq'
  };

  async function nc_configureFilters(viewId, f) {
    for (let i = 0; i < f.filterSet.length; i++) {
      const filter = f.filterSet[i];
      const colSchema = await nc_getColumnSchema(filter.columnId);

      // column not available;
      // one of not migrated column;
      if (!colSchema) {
        addUserInfo(
          `Filter configuration partial: ${sMap.getNcNameFromAtId(viewId)}`
        );
        continue;
      }

      const columnId = colSchema.id;
      const datatype = colSchema.uidt;
      const ncFilters = [];

      // console.log(filter)
      if (datatype === UITypes.Date) {
        // skip filters over data datatype
        addUserInfo(
          `Filter configuration partial: ${sMap.getNcNameFromAtId(viewId)}`
        );
        continue;
      }

      // single-select & multi-select
      else if (
        datatype === UITypes.SingleSelect ||
        datatype === UITypes.MultiSelect
      ) {
        // if array, break it down to multiple filters
        if (Array.isArray(filter.value)) {
          for (let i = 0; i < filter.value.length; i++) {
            const fx = {
              fk_column_id: columnId,
              logical_op: f.conjunction,
              comparison_op: filterMap[filter.operator],
              value: sMap.getNcNameFromAtId(filter.value[i])
            };
            ncFilters.push(fx);
          }
        }
        // not array - add as is
        else if (filter.value) {
          const fx = {
            fk_column_id: columnId,
            logical_op: f.conjunction,
            comparison_op: filterMap[filter.operator],
            value: sMap.getNcNameFromAtId(filter.value)
          };
          ncFilters.push(fx);
        }
      }

      // other data types (number/ text/ long text/ ..)
      else if (filter.value) {
        const fx = {
          fk_column_id: columnId,
          logical_op: f.conjunction,
          comparison_op: filterMap[filter.operator],
          value: filter.value
        };
        ncFilters.push(fx);
      }

      // insert filters
      for (let i = 0; i < ncFilters.length; i++) {
        await api.dbTableFilter.create(viewId, {
          ...ncFilters[i]
        });
        runTimeCounters.filter++;
      }
    }
  }

  async function nc_configureSort(viewId, s) {
    for (let i = 0; i < s.sortSet.length; i++) {
      const columnId = (await nc_getColumnSchema(s.sortSet[i].columnId))?.id;

      if (columnId)
        await api.dbTableSort.create(viewId, {
          fk_column_id: columnId,
          direction: s.sortSet[i].ascending ? 'asc' : 'dsc'
        });
      runTimeCounters.sort++;
    }
  }

  async function nc_configureFields(_viewId, c, tblName, viewName, viewType?) {
    // force hide PK column
    const hiddenColumns = ['_aTbl_nc_rec_id', '_aTbl_nc_rec_hash'];

    // // extract other columns hidden in this view
    // const hiddenColumnID = c.filter(x => x.visibility === false);
    // for (let j = 0; j < hiddenColumnID.length; j++) {
    //   hiddenColumns.push(aTbl_getColumnName(hiddenColumnID[j].columnId).cn);
    // }

    // await nc_hideColumn(tblName, viewName, hiddenColumns, viewType);

    // column order corrections
    // retrieve table schema
    const ncTbl = await nc_getTableSchema(tblName);
    // retrieve view ID
    const viewId = ncTbl.views.find(x => x.title === viewName).id;

    // nc-specific columns; default hide.
    for (let j = 0; j < hiddenColumns.length; j++) {
      const ncColumnId = ncTbl.columns.find(x => x.title === hiddenColumns[j])
        .id;
      const ncViewColumnId = await nc_getViewColumnId(
        viewId,
        viewType,
        ncColumnId
      );
      if (ncViewColumnId === undefined) continue;

      // first two positions held by record id & record hash
      await api.dbViewColumn.update(viewId, ncViewColumnId, {
        show: false,
        order: j + 1
      });
    }

    // rest of the columns from airtable- retain order & visibility property
    for (let j = 0; j < c.length; j++) {
      const ncColumnId = sMap.getNcIdFromAtId(c[j].columnId);
      const ncViewColumnId = await nc_getViewColumnId(
        viewId,
        viewType,
        ncColumnId
      );
      if (ncViewColumnId === undefined) continue;

      // first two positions held by record id & record hash
      await api.dbViewColumn.update(viewId, ncViewColumnId, {
        show: c[j].visibility,
        order: j + 1 + hiddenColumns.length
      });
    }
  }

  ///////////////////////////////////////////////////////////////////////////////
  const userInfo = [];

  function addUserInfo(log) {
    userInfo.push(log);
  }

  try {
    syncLog = progress;
    progress('SDK initialized');
    api = new Api({
      baseURL: syncDB.baseURL,
      headers: {
        'xc-auth': syncDB.authToken
      }
    });

    progress('Project initialization started');
    // delete project if already exists
    if (debugMode) await init(syncDB);

    progress('Project initialized');

    progress('Project schema extraction started');
    // read schema file
    const schema = await getAtableSchema(syncDB);
    const aTblSchema = schema.tableSchemas;
    progress('Project schema extraction completed');

    if (!syncDB.projectId) {
      if (!syncDB.projectName)
        throw new Error('Project name or id not provided');
      // create empty project
      await nocoCreateProject(syncDB.projectName);
      progress('Project created');
    } else {
      await nocoGetProject(syncDB.projectId);
      syncDB.projectName = ncCreatedProjectSchema?.title;
      progress('Getting existing project meta');
    }

    progress('Table creation started');
    // prepare table schema (base)
    await nocoCreateBaseSchema(aTblSchema);
    progress('Table creation completed');

    progress('Migrating LTAR columns');
    // add LTAR
    await nocoCreateLinkToAnotherRecord(aTblSchema);
    progress('Migrating LTAR columns completed');

    progress('Migrating Lookup columns');
    // add look-ups
    await nocoCreateLookups(aTblSchema);
    progress('Migrating Lookup columns completed');

    progress('Migrating Rollup columns');
    // add roll-ups
    await nocoCreateRollups(aTblSchema);
    progress('Migrating Rollup columns completed');

    progress('Migrating Lookup form Rollup columns');
    // lookups for rollups
    await nocoLookupForRollups();
    progress('Migrating Lookup form Rollup columns completed');

    progress('Configuring primary value column');
    // configure primary values
    await nocoSetPrimary(aTblSchema);
    progress('Configuring primary value column completed');

    progress('Adding users');
    // add users
    await nocoAddUsers(schema);
    progress('Adding users completed');

    // hide-fields
    // await nocoReconfigureFields(aTblSchema);

    progress('Syncing views');
    // configure views
    await nocoConfigureGridView(syncDB, aTblSchema);
    await nocoConfigureFormView(syncDB, aTblSchema);
    await nocoConfigureGalleryView(syncDB, aTblSchema);
    progress('Syncing views completed');

    if (process_aTblData) {
      // await nc_DumpTableSchema();
      const ncTblList = await api.dbTable.list(ncCreatedProjectSchema.id);
      for (let i = 0; i < ncTblList.list.length; i++) {
        const ncTbl = await api.dbTable.read(ncTblList.list[i].id);
        progress(`Reading data from ${ncTbl.title}`);
        let c = 0;
        await nocoReadData(syncDB, ncTbl, async (sDB, table, record) => {
          progress(
            `Processing records from ${ncTbl.title} : ${c} - ${(c += 25)}`
          );
          await nocoBaseDataProcessing(sDB, table, record);
        });
        progress(`Data inserted from ${ncTbl.title}`);
      }

      // Configure link @ Data row's
      for (let idx = 0; idx < ncLinkMappingTable.length; idx++) {
        const x = ncLinkMappingTable[idx];
        const ncTbl = await nc_getTableSchema(
          aTbl_getTableName(x.aTbl.tblId).tn
        );
        progress(`Linking data to ${ncTbl.title}`);
        let c = 0;
        await nocoReadDataSelected(
          syncDB.projectName,
          ncTbl,
          async (projName, table, record, _field) => {
            progress(
              `Mapping LTAR records from ${ncTbl.title} : ${c} - ${(c += 25)}`
            );
            await nocoLinkProcessing(projName, table, record, _field);
          },
          x.aTbl.name
        );
        progress(`Linked data to ${ncTbl.title}`);
      }
    }

    if (generate_migrationStats) {
      await generateMigrationStats(aTblSchema);
    }
  } catch (e) {
    if (e.response?.data?.msg) {
      throw new Error(e.response.data.msg);
    }
    throw e;
  }
};

export interface AirtableSyncConfig {
  id: string;
  baseURL: string;
  authToken: string;
  projectName?: string;
  projectId?: string;
  apiKey: string;
  shareId: string;
  syncViews: boolean;
}
