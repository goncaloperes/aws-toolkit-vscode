/*!
 * Copyright 2018-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()
import * as path from 'path'
import * as vscode from 'vscode'
import { SchemaClient } from '../../../src/shared/clients/schemaClient'
import { createSchemaCodeDownloaderObject } from '../..//eventSchemas/commands/downloadSchemaItemCode'
import {
    SchemaCodeDownloader,
    SchemaCodeDownloadRequestDetails,
} from '../../eventSchemas/commands/downloadSchemaItemCode'
import { getApiValueForSchemasDownload } from '../../eventSchemas/models/schemaCodeLangs'
import {
    buildSchemaTemplateParameters,
    SchemaTemplateParameters,
} from '../../eventSchemas/templates/schemasAppTemplateUtils'
import { ActivationLaunchPath } from '../../shared/activationLaunchPath'
import { AwsContext } from '../../shared/awsContext'
import { ext } from '../../shared/extensionGlobals'
import { fileExists } from '../../shared/filesystemUtilities'
import { getLogger } from '../../shared/logger'
import { RegionProvider } from '../../shared/regions/regionProvider'
import { getRegionsForActiveCredentials } from '../../shared/regions/regionUtilities'
import { getSamCliVersion, getSamCliContext, SamCliContext } from '../../shared/sam/cli/samCliContext'
import { runSamCliInit, SamCliInitArgs } from '../../shared/sam/cli/samCliInit'
import { throwAndNotifyIfInvalid } from '../../shared/sam/cli/samCliValidationUtils'
import { SamCliValidator } from '../../shared/sam/cli/samCliValidator'
import { recordSamInit, Result, Runtime } from '../../shared/telemetry/telemetry'
import { makeCheckLogsMessage } from '../../shared/utilities/messages'
import { ChannelLogger } from '../../shared/utilities/vsCodeUtils'
import { addFolderToWorkspace } from '../../shared/utilities/workspaceUtils'
import { getDependencyManager } from '../models/samLambdaRuntime'
import { eventBridgeStarterAppTemplate } from '../models/samTemplates'
import {
    CreateNewSamAppWizard,
    CreateNewSamAppWizardResponse,
    DefaultCreateNewSamAppWizardContext,
} from '../wizards/samInitWizard'
import { LaunchConfiguration } from '../../shared/debug/launchConfiguration'
import { SamDebugConfigProvider } from '../../shared/sam/debugger/awsSamDebugger'
import { ExtContext } from '../../shared/extensions'
import { isTemplateTargetProperties } from '../../shared/sam/debugger/awsSamDebugConfiguration'
import { TemplateTargetProperties } from '../../shared/sam/debugger/awsSamDebugConfiguration'
import * as pathutils from '../../shared/utilities/pathUtils'
import { openLaunchJsonFile } from '../../shared/sam/debugger/commands/addSamDebugConfiguration'

export async function resumeCreateNewSamApp(
    extContext: ExtContext,
    activationLaunchPath: ActivationLaunchPath = new ActivationLaunchPath()
) {
    try {
        const pathToLaunch = activationLaunchPath.getLaunchPath()
        if (!pathToLaunch) {
            return
        }

        const uri = vscode.Uri.file(pathToLaunch)
        const folder = vscode.workspace.getWorkspaceFolder(uri)
        if (!folder) {
            // This should never happen, as `pathToLaunch` will only be set if `uri` is in
            // the newly added workspace folder.
            vscode.window.showErrorMessage(
                localize(
                    'AWS.samcli.initWizard.source.error.notInWorkspace',
                    "Could not open file '{0}'. If this file exists on disk, try adding it to your workspace.",
                    uri.fsPath
                )
            )

            return
        }

        await addInitialLaunchConfiguration(extContext, folder, uri)
        await vscode.window.showTextDocument(uri)
    } finally {
        activationLaunchPath.clearLaunchPath()
    }
}

export interface CreateNewSamApplicationResults {
    runtime: string
    result: Result
}

type createReason = 'unknown' | 'userCancelled' | 'fileNotFound' | 'complete' | 'error'

/**
 * Runs `sam init` in the given context and returns useful metadata about its invocation
 */
export async function createNewSamApplication(
    extContext: ExtContext,
    samCliContext: SamCliContext = getSamCliContext(),
    activationLaunchPath: ActivationLaunchPath = new ActivationLaunchPath()
): Promise<void> {
    let channelLogger: ChannelLogger = extContext.chanLogger
    let awsContext: AwsContext = extContext.awsContext
    let regionProvider: RegionProvider = extContext.regionProvider
    let createResult: Result = 'Succeeded'
    let reason: createReason = 'unknown'
    let createRuntime: Runtime | undefined
    let config: CreateNewSamAppWizardResponse | undefined

    let initArguments: SamCliInitArgs

    try {
        await validateSamCli(samCliContext.validator)

        const currentCredentials = await awsContext.getCredentials()
        const availableRegions = getRegionsForActiveCredentials(awsContext, regionProvider)
        const schemasRegions = availableRegions.filter(region => regionProvider.isServiceInRegion('schemas', region.id))
        const samCliVersion = await getSamCliVersion(samCliContext)

        const wizardContext = new DefaultCreateNewSamAppWizardContext(currentCredentials, schemasRegions, samCliVersion)
        config = await new CreateNewSamAppWizard(wizardContext).run()

        if (!config) {
            createResult = 'Cancelled'
            reason = 'userCancelled'

            return
        }

        // This cast (and all like it) will always succeed because Runtime (from config.runtime) is the same
        // section of types as Runtime
        createRuntime = config.runtime as Runtime

        // TODO: Make this selectable in the wizard to account for runtimes with multiple dependency managers
        const dependencyManager = getDependencyManager(config.runtime)

        initArguments = {
            name: config.name,
            location: config.location.fsPath,
            runtime: config.runtime,
            dependencyManager,
            template: config.template,
        }

        let request: SchemaCodeDownloadRequestDetails
        let schemaCodeDownloader: SchemaCodeDownloader
        let schemaTemplateParameters: SchemaTemplateParameters
        let client: SchemaClient
        if (config.template === eventBridgeStarterAppTemplate) {
            client = ext.toolkitClientBuilder.createSchemaClient(config.region!)
            schemaTemplateParameters = await buildSchemaTemplateParameters(
                config.schemaName!,
                config.registryName!,
                client
            )

            initArguments.extraContent = schemaTemplateParameters.templateExtraContent
        }

        await runSamCliInit(initArguments, samCliContext)

        const uri = await getMainUri(config)
        if (!uri) {
            reason = 'fileNotFound'

            return
        }

        if (config.template === eventBridgeStarterAppTemplate) {
            const destinationDirectory = path.join(config.location.fsPath, config.name, 'hello_world_function')
            request = {
                registryName: config.registryName!,
                schemaName: config.schemaName!,
                language: getApiValueForSchemasDownload(config.runtime),
                schemaVersion: schemaTemplateParameters!.SchemaVersion,
                destinationDirectory: vscode.Uri.file(destinationDirectory),
            }
            schemaCodeDownloader = createSchemaCodeDownloaderObject(client!, channelLogger.channel)
            channelLogger.info(
                'AWS.message.info.schemas.downloadCodeBindings.start',
                'Downloading code for schema {0}...',
                config.schemaName!
            )

            await schemaCodeDownloader!.downloadCode(request!)

            vscode.window.showInformationMessage(
                localize(
                    'AWS.message.info.schemas.downloadCodeBindings.finished',
                    'Downloaded code for schema {0}!',
                    request!.schemaName
                )
            )
        }

        // In case adding the workspace folder triggers a VS Code restart, instruct extension to
        // launch app file after activation.
        activationLaunchPath.setLaunchPath(uri.fsPath)
        await addFolderToWorkspace(
            {
                uri: config.location,
                name: path.basename(config.location.fsPath),
            },
            true
        )

        const newLaunchConfigs = await addInitialLaunchConfiguration(
            extContext,
            vscode.workspace.getWorkspaceFolder(uri)!,
            uri
        )
        await vscode.window.showTextDocument(uri)
        if (newLaunchConfigs && newLaunchConfigs.length > 0) {
            showCompletionNotification(config.name, `"${newLaunchConfigs.map(config => config.name).join('", "')}"`)
        }
        activationLaunchPath.clearLaunchPath()

        reason = 'complete'
    } catch (err) {
        createResult = 'Failed'
        reason = 'error'

        const checkLogsMessage = makeCheckLogsMessage()

        channelLogger.channel.show(true)
        channelLogger.error(
            'AWS.samcli.initWizard.general.error',
            'An error occurred while creating a new SAM Application. {0}',
            checkLogsMessage
        )

        getLogger().error('Error creating new SAM Application: %O', err as Error)

        // An error occured, so do not try to open any files during the next extension activation
        activationLaunchPath.clearLaunchPath()
    } finally {
        recordSamInit({
            result: createResult,
            reason: reason,
            runtime: createRuntime,
            name: config?.name,
        })
    }
}

async function validateSamCli(samCliValidator: SamCliValidator): Promise<void> {
    const validationResult = await samCliValidator.detectValidSamCli()
    throwAndNotifyIfInvalid(validationResult)
}

async function getMainUri(
    config: Pick<CreateNewSamAppWizardResponse, 'location' | 'name'>
): Promise<vscode.Uri | undefined> {
    const cfnTemplatePath = path.resolve(config.location.fsPath, config.name, 'template.yaml')
    if (await fileExists(cfnTemplatePath)) {
        return vscode.Uri.file(cfnTemplatePath)
    } else {
        vscode.window.showWarningMessage(
            localize(
                'AWS.samcli.initWizard.source.error.notFound',
                'Project created successfully, but main source code file not found: {0}',
                cfnTemplatePath
            )
        )
    }
}

export async function addInitialLaunchConfiguration(
    extContext: ExtContext,
    folder: vscode.WorkspaceFolder,
    targetUri: vscode.Uri,
    launchConfiguration: LaunchConfiguration = new LaunchConfiguration(folder.uri)
): Promise<vscode.DebugConfiguration[] | undefined> {
    let configurations = await new SamDebugConfigProvider(extContext).provideDebugConfigurations(folder)
    if (configurations) {
        // add configurations that target the new template file
        const filtered = configurations.filter(
            config =>
                isTemplateTargetProperties(config.invokeTarget) &&
                pathutils.areEqual(
                    folder.uri.fsPath,
                    (config.invokeTarget as TemplateTargetProperties).templatePath,
                    targetUri.fsPath
                )
        )

        await launchConfiguration.addDebugConfigurations(filtered)
        return filtered
    }
}

async function showCompletionNotification(appName: string, configs: string): Promise<void> {
    const action = await vscode.window.showInformationMessage(
        localize(
            'AWS.samcli.initWizard.completionMessage',
            'Created SAM application "{0}" and added launch configurations to launch.json: {1}',
            appName,
            configs
        ),
        localize('AWS.generic.open', 'Open {0}', 'launch.json')
    )

    if (action) {
        await openLaunchJsonFile()
    }
}
