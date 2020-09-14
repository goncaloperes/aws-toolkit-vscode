/*!
 * Copyright 2018 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as assert from 'assert'
import * as sinon from 'sinon'
import { ext } from '../../shared/extensionGlobals'
import { RegionNode } from '../../awsexplorer/regionNode'
import { SchemasNode } from '../../eventSchemas/explorer/schemasNode'
import { DEFAULT_TEST_REGION_CODE, DEFAULT_TEST_REGION_NAME, FakeRegionProvider } from '../utilities/fakeAwsContext'
import { ToolkitClientBuilder } from '../../shared/clients/toolkitClientBuilder'

describe('RegionNode', () => {
    let sandbox: sinon.SinonSandbox
    let testNode: RegionNode

    beforeEach(() => {
        sandbox = sinon.createSandbox()
        console.log('initializing...')

        // contingency for current S3Node impl: requires a client built from ext.toolkitClientBuilder.
        const clientBuilder = {
            createS3Client: sandbox.stub().returns({}),
        }
        ext.toolkitClientBuilder = (clientBuilder as any) as ToolkitClientBuilder

        testNode = new RegionNode({ id: regionCode, name: regionName }, new FakeRegionProvider())
    })

    afterEach(() => {
        sandbox.reset()
    })

    const regionCode = DEFAULT_TEST_REGION_CODE
    const regionName = DEFAULT_TEST_REGION_NAME

    it('initializes name and tooltip', async () => {
        assert.strictEqual(testNode.label, regionName)
        assert.strictEqual(testNode.tooltip, `${regionName} [${regionCode}]`)
    })

    it('contains children', async () => {
        const childNodes = await testNode.getChildren()
        assert.ok(childNodes.length > 0, 'Expected region node to have child nodes')
    })

    it('does not have child nodes for services not available in a region', async () => {
        const regionProvider = new FakeRegionProvider()
        regionProvider.servicesNotInRegion.push('schemas')
        const regionNode = new RegionNode({ id: regionCode, name: regionName }, regionProvider)

        const childNodes = await regionNode.getChildren()
        assert.ok(
            childNodes.filter(node => node instanceof SchemasNode).length === 0,
            'Expected Schemas node to be absent from child nodes'
        )
    })
})
