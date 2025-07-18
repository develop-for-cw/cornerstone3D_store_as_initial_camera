import { normalizers, data, utilities, derivations } from "dcmjs";
import { cache } from "@cornerstonejs/core";

import CORNERSTONE_3D_TAG from "./cornerstone3DTag";
import { toArray, codeMeaningEquals, copyStudyTags } from "../helpers";
import Cornerstone3DCodingScheme from "./CodingScheme";
import { copySeriesTags } from "../helpers/copySeriesTags";
import { NO_IMAGE_ID } from "./constants";

const { TID1500, addAccessors } = utilities;

const { StructuredReport } = derivations;

const { Normalizer } = normalizers;

const { TID1500MeasurementReport, TID1501MeasurementGroup } = TID1500;

const { DicomMetaDictionary } = data;

const FINDING = { CodingSchemeDesignator: "DCM", CodeValue: "121071" };
const FINDING_SITE = { CodingSchemeDesignator: "SCT", CodeValue: "363698007" };
const FINDING_SITE_OLD = { CodingSchemeDesignator: "SRT", CodeValue: "G-C0E3" };

type SpatialCoordinatesState = {
    description?: string;
    sopInstanceUid?: string;
    annotation: {
        annotationUID: string;
        metadata: {
            toolName: string;
            referencedImageId?: string;
            FrameOfReferenceUID: string;
            label: string;
        };
        data?: unknown;
    };
    finding?: unknown;
    findingSites?: unknown;
};

type SetupMeasurementData = {
    defaultState: SpatialCoordinatesState;
    NUMGroup: Record<string, unknown>;
    SCOORDGroup?: Record<string, unknown>;
    ReferencedSOPSequence?: Record<string, unknown>;
    ReferencedSOPInstanceUID?: string;
    ReferencedFrameNumber?: string;
    SCOORD3DGroup?: Record<string, unknown>;
    FrameOfReferenceUID?: string;
};

type SpatialCoordinatesData = Omit<
    SetupMeasurementData,
    "defaultState" | "NUMGroup"
> & {
    state: SpatialCoordinatesState;
};

export type AdapterOptions = {
    /**
     * The parent type is another type which could be used to parse this instance,
     * but for which this sub-class has a better representation.  For example,
     * key images are parseable as Probe instances, but are represented as a different tool
     * Thus, the name for the key image is `Cornerstone3DTag:Probe:KeyImage` so that
     * a prefix query testing just the Probe could parse this object and display it,
     * but a better/full path key could also be done.
     */
    parentType?: string;

    /**
     * If set, then replace this
     */
    replace?: boolean | ((original: MeasurementAdapter) => void);
};

/**
 * A measurement adapter parses/creates data for DICOM SR measurements
 */
export interface MeasurementAdapter {
    toolType: string;
    TID300Representation;
    trackingIdentifierTextValue: string;
    trackingIdentifiers: Set<string>;

    /**
     * The parent type is the base type of the adapter that is used for the
     * identifier, being compatible with older versions to read that subtype.
     */
    parentType: string;

    /**
     * Applies the options and registers this tool
     */
    init(toolType: string, representation, options?: AdapterOptions);

    getMeasurementData(
        measurementGroup,
        sopInstanceUIDToImageIdMap,
        imageToWorldCoords,
        metadata,
        trackingIdentifier: string
    );

    isValidCornerstoneTrackingIdentifier(trackingIdentifier: string): boolean;

    getTID300RepresentationArguments(
        tool,
        worldToImageCoords
    ): Record<string, unknown>;
}

export default class MeasurementReport {
    public static CORNERSTONE_3D_TAG = CORNERSTONE_3D_TAG;

    /** Maps tool type to the adapter name used to serialize this item to SR */
    public static measurementAdapterByToolType = new Map<
        string,
        MeasurementAdapter
    >();

    /** Maps tracking identifier to tool class to deserialize from SR into a tool instance */
    public static measurementAdapterByTrackingIdentifier = new Map<
        string,
        MeasurementAdapter
    >();

    public static getTID300ContentItem(
        tool,
        ReferencedSOPSequence,
        toolClass,
        worldToImageCoords
    ) {
        const args = toolClass.getTID300RepresentationArguments(
            tool,
            worldToImageCoords
        );
        args.ReferencedSOPSequence = ReferencedSOPSequence;

        const TID300Measurement = new toolClass.TID300Representation(args);
        return TID300Measurement;
    }

    public static codeValueMatch = (group, code, oldCode?) => {
        const { ConceptNameCodeSequence } = group;
        if (!ConceptNameCodeSequence) {
            return;
        }
        const { CodingSchemeDesignator, CodeValue } = ConceptNameCodeSequence;
        return (
            (CodingSchemeDesignator == code.CodingSchemeDesignator &&
                CodeValue == code.CodeValue) ||
            (oldCode &&
                CodingSchemeDesignator == oldCode.CodingSchemeDesignator &&
                CodeValue == oldCode.CodeValue)
        );
    };

    public static getMeasurementGroup(
        toolType,
        toolData,
        ReferencedSOPSequence,
        worldToImageCoords
    ) {
        const toolTypeData = toolData[toolType];
        const toolClass = this.measurementAdapterByToolType.get(toolType);
        if (
            !toolTypeData ||
            !toolTypeData.data ||
            !toolTypeData.data.length ||
            !toolClass
        ) {
            return;
        }

        // Loop through the array of tool instances
        // for this tool
        const Measurements = toolTypeData.data.map(tool => {
            return this.getTID300ContentItem(
                tool,
                ReferencedSOPSequence,
                toolClass,
                worldToImageCoords
            );
        });

        return new TID1501MeasurementGroup(Measurements);
    }

    static getCornerstoneLabelFromDefaultState(defaultState) {
        const { findingSites = [], finding } = defaultState;

        const cornersoneFreeTextCodingValue =
            Cornerstone3DCodingScheme.codeValues.CORNERSTONEFREETEXT;

        const freeTextLabel = findingSites.find(
            fs => fs.CodeValue === cornersoneFreeTextCodingValue
        );

        if (freeTextLabel) {
            return freeTextLabel.CodeMeaning;
        }

        if (finding && finding.CodeValue === cornersoneFreeTextCodingValue) {
            return finding.CodeMeaning;
        }
    }

    static generateDatasetMeta() {
        // TODO: what is the correct metaheader
        // http://dicom.nema.org/medical/Dicom/current/output/chtml/part10/chapter_7.html
        // TODO: move meta creation to happen in derivations.js
        const fileMetaInformationVersionArray = new Uint8Array(2);
        fileMetaInformationVersionArray[1] = 1;

        const _meta = {
            FileMetaInformationVersion: {
                Value: [fileMetaInformationVersionArray.buffer],
                vr: "OB"
            },
            //MediaStorageSOPClassUID
            //MediaStorageSOPInstanceUID: sopCommonModule.sopInstanceUID,
            TransferSyntaxUID: {
                Value: ["1.2.840.10008.1.2.1"],
                vr: "UI"
            },
            ImplementationClassUID: {
                Value: [DicomMetaDictionary.uid()], // TODO: could be git hash or other valid id
                vr: "UI"
            },
            ImplementationVersionName: {
                Value: ["dcmjs"],
                vr: "SH"
            }
        };

        return _meta;
    }

    static generateDerivationSourceDataset = instance => {
        const studyTags = copyStudyTags(instance);
        const seriesTags = copySeriesTags(instance);

        return { ...studyTags, ...seriesTags };
    };

    public static processSCOORDGroup({
        SCOORDGroup,
        toolType,
        sopInstanceUIDToImageIdMap,
        metadata
    }): SpatialCoordinatesData {
        const { ReferencedSOPSequence } = SCOORDGroup.ContentSequence;
        const { ReferencedSOPInstanceUID, ReferencedFrameNumber } =
            ReferencedSOPSequence;

        const referencedImageId =
            sopInstanceUIDToImageIdMap[ReferencedSOPInstanceUID];
        const imagePlaneModule = metadata.get(
            "imagePlaneModule",
            referencedImageId
        );

        return {
            SCOORDGroup,
            ReferencedSOPSequence,
            ReferencedSOPInstanceUID,
            ReferencedFrameNumber,
            state: {
                description: undefined,
                sopInstanceUid: ReferencedSOPInstanceUID,
                annotation: {
                    annotationUID: DicomMetaDictionary.uid(),
                    metadata: {
                        toolName: toolType,
                        referencedImageId,
                        FrameOfReferenceUID:
                            imagePlaneModule.frameOfReferenceUID,
                        label: ""
                    }
                }
            }
        };
    }

    public static processSCOORD3DGroup({
        SCOORD3DGroup,
        toolType
    }): SpatialCoordinatesData {
        return {
            SCOORD3DGroup,
            FrameOfReferenceUID: SCOORD3DGroup.ReferencedFrameOfReferenceUID,
            state: {
                description: undefined,
                annotation: {
                    annotationUID: DicomMetaDictionary.uid(),
                    metadata: {
                        toolName: toolType,
                        FrameOfReferenceUID:
                            SCOORD3DGroup.ReferencedFrameOfReferenceUID,
                        label: ""
                    }
                }
            }
        };
    }

    public static getSpatialCoordinatesState({
        NUMGroup,
        sopInstanceUIDToImageIdMap,
        metadata,
        toolType
    }): SpatialCoordinatesData {
        const SCOORDGroup = toArray(NUMGroup.ContentSequence).find(
            group => group.ValueType === "SCOORD"
        );
        const SCOORD3DGroup = toArray(NUMGroup.ContentSequence).find(
            group => group.ValueType === "SCOORD3D"
        );

        if (SCOORDGroup) {
            return this.processSCOORDGroup({
                SCOORDGroup,
                toolType,
                metadata,
                sopInstanceUIDToImageIdMap
            });
        } else if (SCOORD3DGroup) {
            return this.processSCOORD3DGroup({ SCOORD3DGroup, toolType });
        } else {
            throw new Error("No spatial coordinates group found.");
        }
    }

    public static processSpatialCoordinatesGroup({
        NUMGroup,
        sopInstanceUIDToImageIdMap,
        metadata,
        findingGroup,
        findingSiteGroups,
        toolType
    }) {
        const {
            state,
            SCOORDGroup,
            ReferencedSOPSequence,
            ReferencedSOPInstanceUID,
            ReferencedFrameNumber,
            SCOORD3DGroup,
            FrameOfReferenceUID
        } = this.getSpatialCoordinatesState({
            NUMGroup,
            sopInstanceUIDToImageIdMap,
            metadata,
            toolType
        });

        const finding = findingGroup
            ? addAccessors(findingGroup.ConceptCodeSequence)
            : undefined;
        const findingSites = findingSiteGroups.map(fsg => {
            return addAccessors(fsg.ConceptCodeSequence);
        });

        const defaultState = {
            ...state,
            finding,
            findingSites
        };

        if (defaultState.finding) {
            defaultState.description = defaultState.finding.CodeMeaning;
        }

        defaultState.annotation.metadata.label =
            MeasurementReport.getCornerstoneLabelFromDefaultState(defaultState);

        return {
            defaultState,
            NUMGroup,
            SCOORDGroup,
            ReferencedSOPSequence,
            ReferencedSOPInstanceUID,
            ReferencedFrameNumber,
            SCOORD3DGroup,
            FrameOfReferenceUID
        };
    }

    public static getSetupMeasurementData(
        MeasurementGroup,
        sopInstanceUIDToImageIdMap,
        metadata,
        toolType
    ): SetupMeasurementData {
        const { ContentSequence } = MeasurementGroup;

        const contentSequenceArr = toArray(ContentSequence);
        const findingGroup = contentSequenceArr.find(group =>
            this.codeValueMatch(group, FINDING)
        );
        const findingSiteGroups =
            contentSequenceArr.filter(group =>
                this.codeValueMatch(group, FINDING_SITE, FINDING_SITE_OLD)
            ) || [];
        const NUMGroup = contentSequenceArr.find(
            group => group.ValueType === "NUM"
        );

        return this.processSpatialCoordinatesGroup({
            NUMGroup,
            sopInstanceUIDToImageIdMap,
            metadata,
            findingGroup,
            findingSiteGroups,
            toolType
        });
    }

    static generateReferencedSOPSequence({
        toolData,
        toolTypes,
        metadataProvider,
        imageId,
        sopInstanceUIDsToSeriesInstanceUIDMap,
        derivationSourceDatasets
    }) {
        const effectiveImageId =
            imageId === NO_IMAGE_ID
                ? this.getImageIdFromVolume({ toolData, toolTypes })
                : imageId;

        const sopCommonModule = metadataProvider.get(
            "sopCommonModule",
            effectiveImageId
        );
        const instance = metadataProvider.get("instance", effectiveImageId);

        const { sopInstanceUID, sopClassUID } = sopCommonModule;
        const { SeriesInstanceUID: seriesInstanceUID } = instance;

        sopInstanceUIDsToSeriesInstanceUIDMap[sopInstanceUID] =
            seriesInstanceUID;

        if (
            !derivationSourceDatasets.find(
                dsd => dsd.SeriesInstanceUID === seriesInstanceUID
            )
        ) {
            // Entry not present for series, create one.
            const derivationSourceDataset =
                MeasurementReport.generateDerivationSourceDataset(instance);

            derivationSourceDatasets.push(derivationSourceDataset);
        }

        const frameNumber = metadataProvider.get(
            "frameNumber",
            effectiveImageId
        );

        const ReferencedSOPSequence = {
            ReferencedSOPClassUID: sopClassUID,
            ReferencedSOPInstanceUID: sopInstanceUID,
            ReferencedFrameNumber: undefined
        };

        if (
            (instance &&
                instance.NumberOfFrames &&
                instance.NumberOfFrames > 1) ||
            Normalizer.isMultiframeSOPClassUID(sopClassUID)
        ) {
            ReferencedSOPSequence.ReferencedFrameNumber = frameNumber;
        }

        return ReferencedSOPSequence;
    }

    static getImageIdFromVolume({ toolData, toolTypes }) {
        const referenceToolData = toolData?.[toolTypes?.[0]]?.data?.[0];
        const volumeId = referenceToolData?.metadata?.volumeId;
        const volume = cache.getVolume(volumeId);
        const imageId = volume.imageIds[0];
        return imageId;
    }

    static generateReport(
        toolState,
        metadataProvider,
        worldToImageCoords,
        options
    ) {
        // ToolState for array of imageIDs to a Report
        // Assume Cornerstone metadata provider has access to Study / Series / Sop Instance UID
        let allMeasurementGroups = [];

        /* Patient ID
        Warning - Missing attribute or value that would be needed to build DICOMDIR - Patient ID
        Warning - Missing attribute or value that would be needed to build DICOMDIR - Study Date
        Warning - Missing attribute or value that would be needed to build DICOMDIR - Study Time
        Warning - Missing attribute or value that would be needed to build DICOMDIR - Study ID
        */

        const sopInstanceUIDsToSeriesInstanceUIDMap = {};
        const derivationSourceDatasets = [];

        const _meta = MeasurementReport.generateDatasetMeta();
        let is3DSR = false;

        // Loop through each image in the toolData
        Object.keys(toolState).forEach(imageId => {
            const toolData = toolState[imageId];
            const toolTypes = Object.keys(toolData);

            const ReferencedSOPSequence = this.generateReferencedSOPSequence({
                toolData,
                toolTypes,
                metadataProvider,
                imageId,
                sopInstanceUIDsToSeriesInstanceUIDMap,
                derivationSourceDatasets
            });

            if (imageId === NO_IMAGE_ID) {
                is3DSR = true;
            }

            // Loop through each tool type for the image
            const measurementGroups = [];

            toolTypes.forEach(toolType => {
                const group = this.getMeasurementGroup(
                    toolType,
                    toolData,
                    ReferencedSOPSequence,
                    worldToImageCoords
                );
                if (group) {
                    measurementGroups.push(group);
                }
            });

            allMeasurementGroups =
                allMeasurementGroups.concat(measurementGroups);
        });

        const tid1500MeasurementReport = new TID1500MeasurementReport(
            { TID1501MeasurementGroups: allMeasurementGroups },
            options
        );

        const report = new StructuredReport(derivationSourceDatasets, options);

        const contentItem = tid1500MeasurementReport.contentItem(
            derivationSourceDatasets,
            { ...options, sopInstanceUIDsToSeriesInstanceUIDMap }
        );

        // Merge the derived dataset with the content from the Measurement Report
        report.dataset = Object.assign(report.dataset, contentItem);
        report.dataset._meta = _meta;
        report.SpecificCharacterSet = "ISO_IR 192";

        if (is3DSR) {
            report.dataset.SOPClassUID =
                DicomMetaDictionary.sopClassUIDsByName.Comprehensive3DSR;
        }

        return report;
    }

    /**
     * Generate Cornerstone tool state from dataset
     */
    static generateToolState(
        dataset,
        sopInstanceUIDToImageIdMap,
        imageToWorldCoords,
        metadata,
        hooks
    ) {
        // For now, bail out if the dataset is not a TID1500 SR with length measurements
        if (dataset.ContentTemplateSequence.TemplateIdentifier !== "1500") {
            throw new Error(
                "This package can currently only interpret DICOM SR TID 1500"
            );
        }

        const REPORT = "Imaging Measurements";
        const GROUP = "Measurement Group";
        const TRACKING_IDENTIFIER = "Tracking Identifier";
        const TRACKING_UNIQUE_IDENTIFIER = "Tracking Unique Identifier";

        // Identify the Imaging Measurements
        const imagingMeasurementContent = toArray(dataset.ContentSequence).find(
            codeMeaningEquals(REPORT)
        );

        // Retrieve the Measurements themselves
        const measurementGroups = toArray(
            imagingMeasurementContent.ContentSequence
        ).filter(codeMeaningEquals(GROUP));

        // For each of the supported measurement types, compute the measurement data
        const measurementData = {};

        measurementGroups.forEach(measurementGroup => {
            try {
                const measurementGroupContentSequence = toArray(
                    measurementGroup.ContentSequence
                );

                const trackingIdentifierGroup =
                    measurementGroupContentSequence.find(
                        contentItem =>
                            contentItem.ConceptNameCodeSequence.CodeMeaning ===
                            TRACKING_IDENTIFIER
                    );

                const { TextValue: trackingIdentifierValue } =
                    trackingIdentifierGroup;

                const trackingUniqueIdentifierGroup =
                    measurementGroupContentSequence.find(
                        contentItem =>
                            contentItem.ConceptNameCodeSequence.CodeMeaning ===
                            TRACKING_UNIQUE_IDENTIFIER
                    );

                const trackingUniqueIdentifierValue =
                    trackingUniqueIdentifierGroup?.UID;

                const toolAdapter =
                    hooks?.getToolClass?.(
                        measurementGroup,
                        dataset,
                        this.measurementAdapterByToolType
                    ) ||
                    this.getAdapterForTrackingIdentifier(
                        trackingIdentifierValue
                    );

                if (toolAdapter) {
                    const measurement = toolAdapter.getMeasurementData(
                        measurementGroup,
                        sopInstanceUIDToImageIdMap,
                        imageToWorldCoords,
                        metadata,
                        trackingIdentifierValue
                    );

                    measurement.TrackingUniqueIdentifier =
                        trackingUniqueIdentifierValue;

                    console.log(`=== ${toolAdapter.toolType} ===`);
                    console.log(measurement);
                    measurementData[toolAdapter.toolType] ||= [];
                    measurementData[toolAdapter.toolType].push(measurement);
                }
            } catch (e) {
                console.warn(
                    "Unable to generate tool state for",
                    measurementGroup,
                    e
                );
            }
        });

        // NOTE: There is no way of knowing the cornerstone imageIds as that could be anything.
        // That is up to the consumer to derive from the SOPInstanceUIDs.
        return measurementData;
    }

    /**
     * Register a new tool type.
     * @param toolAdapter to perform I/O to DICOM for this tool
     */
    public static registerTool(
        toolAdapter: MeasurementAdapter,
        replace: boolean | ((original) => void) = false
    ) {
        const registerName = toolAdapter.toolType;
        if (this.measurementAdapterByToolType.has(registerName)) {
            if (!replace) {
                throw new Error(
                    `The registered tool name ${registerName} already exists in adapters, use a different toolType or use replace`
                );
            }
            if (typeof replace === "function") {
                // Call the function so it can call parent output
                replace(this.measurementAdapterByToolType.get(registerName));
            }
        }
        this.measurementAdapterByToolType.set(
            toolAdapter.toolType,
            toolAdapter
        );
        this.measurementAdapterByTrackingIdentifier.set(
            toolAdapter.trackingIdentifierTextValue,
            toolAdapter
        );
    }

    public static registerTrackingIdentifier(
        toolClass,
        ...trackingIdentifiers: string[]
    ) {
        for (const identifier of trackingIdentifiers) {
            this.measurementAdapterByTrackingIdentifier.set(
                identifier,
                toolClass
            );
        }
    }

    public static getAdapterForTrackingIdentifier(trackingIdentifier: string) {
        const adapter =
            this.measurementAdapterByTrackingIdentifier.get(trackingIdentifier);
        if (adapter) {
            return adapter;
        }
        for (const adapterTest of [
            ...this.measurementAdapterByToolType.values()
        ]) {
            if (
                adapterTest.isValidCornerstoneTrackingIdentifier(
                    trackingIdentifier
                )
            ) {
                this.measurementAdapterByTrackingIdentifier.set(
                    trackingIdentifier,
                    adapterTest
                );
                return adapterTest;
            }
        }
    }
}
