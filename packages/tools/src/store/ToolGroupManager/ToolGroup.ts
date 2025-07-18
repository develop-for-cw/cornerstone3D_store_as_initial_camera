import { MouseBindings, ToolModes, Events } from '../../enums';
import get from 'lodash.get';
import {
  triggerEvent,
  eventTarget,
  getRenderingEngine,
  getRenderingEngines,
  getEnabledElementByIds,
  Settings,
} from '@cornerstonejs/core';
import { type Types, utilities } from '@cornerstonejs/core';
import type {
  ToolActivatedEventDetail,
  ToolModeChangedEventDetail,
} from '../../types/EventTypes';
import { state } from '../state';
import type {
  IToolBinding,
  IToolClassReference,
  IToolGroup,
  SetToolBindingsType,
  ToolOptionsType,
  ToolConfiguration,
} from '../../types';

import { MouseCursor, SVGMouseCursor } from '../../cursors';
import { initElementCursor } from '../../cursors/elementCursor';
import getToolGroup from './getToolGroup';

const { Active, Passive, Enabled, Disabled } = ToolModes;

const PRIMARY_BINDINGS = [{ mouseButton: MouseBindings.Primary }];

/**
 * ToolGroup class which is a container for tools and their modes and states.
 * In Cornerstone3DTools, you need to create a tool group in order to use the
 * tools. ToolGroup is a way to share tool configuration, state (enabled, disabled, etc.)
 * across a set of viewports. Tools can set to be activated, enabled or disabled
 * in a toolGroup. You should not directly instantiate a ToolGroup. You need to use
 * ToolGroupManager helpers to create a new toolGroup or get a reference to an existing toolGroup.
 *
 *
 * `const toolGroup = csTools.ToolGroupManager.createToolGroup('toolGroupId')`
 */
export default class ToolGroup {
  id: string;
  viewportsInfo = [];
  toolOptions = {};
  currentActivePrimaryToolName: string | null = null;
  prevActivePrimaryToolName: string | null = null;
  /**
   * Options used for restoring a tool
   */
  restoreToolOptions = {};
  _toolInstances = {};

  constructor(id: string) {
    this.id = id;
  }

  /**
   * Get the viewport IDs of all the viewports in the current viewport
   * @returns An array of viewport IDs.
   */
  getViewportIds(): string[] {
    return this.viewportsInfo.map(({ viewportId }) => viewportId);
  }

  /**
   * Returns the toolGroup viewports info which is an array of `{viewportId, renderingEngineId}`
   */
  getViewportsInfo(): Array<Types.IViewportId> {
    return this.viewportsInfo.slice();
  }

  /**
   * Get the tool instance for a given tool name in the toolGroup
   * @param toolName - The name of the tool.
   * @returns A tool instance.
   */
  public getToolInstance(toolInstanceName: string) {
    const toolInstance = this._toolInstances[toolInstanceName];
    if (!toolInstance) {
      console.warn(
        `'${toolInstanceName}' is not registered with this toolGroup (${this.id}).`
      );
      return;
    }

    return toolInstance;
  }

  /**
   * Retrieves the tool instances associated with this tool group.
   *
   * @returns A record containing the tool instances, where the keys are the tool names and the values are the tool instances.
   */
  public getToolInstances(): Record<string, unknown> {
    return this._toolInstances;
  }

  /**
   * Check if a tool is already added to the tool group
   * @param toolName - Tool name
   * @returns True if the tool is already added or false otherwise
   */
  hasTool(toolName: string): boolean {
    return !!this._toolInstances[toolName];
  }

  /**
   * Add a tool to the tool group with the given tool name and tool configuration.
   * Note that adding a tool to a tool group will not automatically set the tool
   * to be active. You must call setToolActive or setToolPassive and other methods
   * to set the tool to be active or passive or in other states.
   *
   * @param toolName - string
   * @param configuration - Tool configuration objects and a custom statistics calculator if needed
   */
  addTool(toolName: string, configuration: ToolConfiguration = {}): void {
    const toolDefinition = state.tools[toolName];
    const hasToolName = typeof toolName !== 'undefined' && toolName !== '';
    const localToolInstance = this.toolOptions[toolName];

    if (!hasToolName) {
      console.warn(
        'Tool with configuration did not produce a toolName: ',
        configuration
      );
      return;
    }

    if (!toolDefinition) {
      console.warn(
        `'${toolName}' is not registered with the library. You need to use cornerstoneTools.addTool to register it.`
      );
      return;
    }

    if (localToolInstance) {
      console.warn(
        `'${toolName}' is already registered for ToolGroup ${this.id}.`
      );
      return;
    }

    // Should these be renamed higher up, so we don't have to alias?
    // Wrap in try-catch so 3rd party tools don't explode?
    const { toolClass: ToolClass } = toolDefinition;

    const toolProps = {
      name: toolName,
      toolGroupId: this.id,
      configuration,
    };

    const instantiatedTool = new ToolClass(toolProps);

    // API instead of directly exposing schema?
    // Maybe not here, but feels like a "must" for any method outside of the ToolGroup itself
    this._toolInstances[toolName] = instantiatedTool;
  }

  public addToolInstance(
    toolName: string,
    parentClassName: string,
    configuration = {}
  ): void {
    let ToolClassToUse = state.tools[toolName]
      ?.toolClass as IToolClassReference;

    if (!ToolClassToUse) {
      // get parent class constructor
      const ParentClass = state.tools[parentClassName]
        .toolClass as IToolClassReference;

      // Todo: could not find a way to make this work with typescript
      // @ts-ignore
      class ToolInstance extends ParentClass {}
      // @ts-ignore
      ToolInstance.toolName = toolName;
      // @ts-ignore
      ToolClassToUse = ToolInstance;

      state.tools[toolName] = {
        toolClass: ToolInstance as IToolClassReference,
      };
    }

    // add the tool to the toolGroup
    // @ts-ignore
    this.addTool(ToolClassToUse.toolName, configuration);
  }

  /**
   * Add a viewport to the ToolGroup. It accepts viewportId and optional
   * renderingEngineId parameter. If renderingEngineId is not provided,
   * it checks if cornerstone-core has more than one renderingEngine; If so,
   * it will throw an error. If cornerstone-core has only one renderingEngine,
   * it will use that renderingEngine.
   *
   * @param viewportId - The unique identifier for the viewport.
   * @param renderingEngineId - The rendering engine to use.
   */
  public addViewport(viewportId: string, renderingEngineId?: string): void {
    if (typeof viewportId !== 'string') {
      throw new Error('viewportId must be defined and be a string');
    }

    const renderingEngineUIDToUse = this._findRenderingEngine(
      viewportId,
      renderingEngineId
    );

    // Don't overwrite if it already exists
    if (
      !this.viewportsInfo.some(({ viewportId: vpId }) => vpId === viewportId)
    ) {
      this.viewportsInfo.push({
        viewportId,
        renderingEngineId: renderingEngineUIDToUse,
      });
    }

    // Handle the newly added viewport's mouse cursor
    const toolName = this.getActivePrimaryMouseButtonTool();

    this.setViewportsCursorByToolName(toolName);

    const eventDetail = {
      toolGroupId: this.id,
      viewportId,
      renderingEngineId: renderingEngineUIDToUse,
    };

    triggerEvent(eventTarget, Events.TOOLGROUP_VIEWPORT_ADDED, eventDetail);
  }

  /**
   * Removes viewport from the toolGroup. If only renderingEngineId is defined
   * it removes all the viewports with the same renderingEngineId, if viewportId
   * is also provided, it will remove that specific viewport from the ToolGroup.
   *
   * @param renderingEngineId - renderingEngine id
   * @param viewportId - viewport id
   */
  public removeViewports(renderingEngineId: string, viewportId?: string): void {
    const indices = [];

    this.viewportsInfo.forEach((vpInfo, index) => {
      let match = false;
      if (vpInfo.renderingEngineId === renderingEngineId) {
        match = true;

        if (viewportId && vpInfo.viewportId !== viewportId) {
          match = false;
        }
      }
      if (match) {
        indices.push(index);
      }
    });

    if (indices.length) {
      // Note: Traverse the array backwards, such that when we remove items we
      // do not immediately mess up our loop indicies.
      for (let i = indices.length - 1; i >= 0; i--) {
        this.viewportsInfo.splice(indices[i], 1);
      }
    }

    const eventDetail = {
      toolGroupId: this.id,
      viewportId,
      renderingEngineId,
    };

    triggerEvent(eventTarget, Events.TOOLGROUP_VIEWPORT_REMOVED, eventDetail);
  }

  public setActiveStrategy(toolName: string, strategyName: string) {
    const toolInstance = this._toolInstances[toolName];

    if (toolInstance === undefined) {
      console.warn(
        `Tool ${toolName} not added to toolGroup, can't set tool configuration.`
      );

      return;
    }

    toolInstance.setActiveStrategy(strategyName);
  }

  setToolMode(
    toolName: string,
    mode: ToolModes,
    options = {} as SetToolBindingsType
  ): void {
    if (!toolName) {
      console.warn('setToolMode: toolName must be defined');
      return;
    }

    if (mode === ToolModes.Active) {
      this.setToolActive(
        toolName,
        options || this.restoreToolOptions[toolName]
      );
      return;
    }

    if (mode === ToolModes.Passive) {
      this.setToolPassive(toolName);
      return;
    }

    if (mode === ToolModes.Enabled) {
      this.setToolEnabled(toolName);
      return;
    }

    if (mode === ToolModes.Disabled) {
      this.setToolDisabled(toolName);
      return;
    }

    console.warn('setToolMode: mode must be defined');
  }

  /**
   * Set the tool mode on the toolGroup to be Active. This means the tool
   * can be actively used by the defined bindings (e.g., Mouse primary click)
   *
   * - Can be actively used by mouse/touch events mapped to its `ToolBinding`s.
   * - Can add data if an annotation tool.
   * - Can be passively interacted by grabbing a tool or its handles.
   * - Renders data if the tool has a `renderAnnotation` method.
   *
   * @param toolName - tool name
   * @param toolBindingsOptions - tool bindings
   */
  public setToolActive(
    toolName: string,
    toolBindingsOptions = {} as SetToolBindingsType
  ): void {
    const toolInstance = this._toolInstances[toolName];

    if (toolInstance === undefined) {
      console.warn(
        `Tool ${toolName} not added to toolGroup, can't set tool mode.`
      );

      return;
    }

    if (!toolInstance) {
      console.warn(
        `'${toolName}' instance ${toolInstance} is not registered with this toolGroup, can't set tool mode.`
      );
      return;
    }

    const prevBindings: IToolBinding[] = this.toolOptions[toolName]
      ? this.toolOptions[toolName].bindings
      : [];

    const newBindings = toolBindingsOptions.bindings
      ? toolBindingsOptions.bindings
      : [];

    // combine the new bindings with the previous bindings to avoid duplicates
    // it allows duplicated mouse buttons as long as they don't have same
    // modifier keys.
    const bindingsToUse = [...prevBindings, ...newBindings].reduce(
      (unique, binding) => {
        const TouchBinding = binding.numTouchPoints !== undefined;
        const MouseBinding = binding.mouseButton !== undefined;

        if (
          !unique.some((obj) => hasSameBinding(obj, binding)) &&
          (TouchBinding || MouseBinding)
        ) {
          unique.push(binding);
        }
        return unique;
      },
      []
    );

    // We should not override the bindings if they are already set
    const toolOptions: ToolOptionsType = {
      bindings: bindingsToUse,
      mode: Active,
    };

    this.toolOptions[toolName] = toolOptions;
    this._toolInstances[toolName].mode = Active;

    if (!this._hasMousePrimaryButtonBinding(toolBindingsOptions)) {
      // reset to default cursor only if there is no other tool with primary binding
      const activeToolIdentifier = this.getActivePrimaryMouseButtonTool();
      if (!activeToolIdentifier) {
        const cursor = MouseCursor.getDefinedCursor('default');
        this._setCursorForViewports(cursor);
      }
    } else {
      // reset the mouse cursor if tool has left click binding
      this.setViewportsCursorByToolName(toolName);
    }

    // if it is a primary tool binding, we should store it as the previous primary tool
    // so that we can restore it when the tool is disabled if desired
    if (this._hasMousePrimaryButtonBinding(toolBindingsOptions)) {
      if (this.prevActivePrimaryToolName === null) {
        this.prevActivePrimaryToolName = toolName;
      } else {
        this.prevActivePrimaryToolName = this.currentActivePrimaryToolName;
      }

      this.currentActivePrimaryToolName = toolName;
    }

    if (typeof toolInstance.onSetToolActive === 'function') {
      toolInstance.onSetToolActive();
    }
    this._renderViewports();

    const eventDetail: ToolActivatedEventDetail = {
      toolGroupId: this.id,
      toolName,
      toolBindingsOptions,
    };

    triggerEvent(eventTarget, Events.TOOL_ACTIVATED, eventDetail);
    this._triggerToolModeChangedEvent(toolName, Active, toolBindingsOptions);
  }

  /**
   * Set the tool mode on the toolGroup to be Passive.
   *
   * - Can be passively interacted by grabbing a tool or its handles.
   * - Renders data if the tool has a `renderAnnotation` method.
   *
   * @param toolName - tool name
   * @param options - Options used when setting the tool as passive
   *  - removeAllBindings: only the primary button bindings are removed but
   *  if this parameter is set to true all bindings are removed.
   */
  public setToolPassive(
    toolName: string,
    options?: { removeAllBindings?: boolean | IToolBinding[] }
  ): void {
    const toolInstance = this._toolInstances[toolName];

    if (toolInstance === undefined) {
      console.warn(
        `Tool ${toolName} not added to toolGroup, can't set tool mode.`
      );

      return;
    }

    // We should only remove the primary button bindings and keep
    // the other ones (Zoom on right click)
    const prevToolOptions = this.getToolOptions(toolName);
    const toolOptions = Object.assign(
      {
        bindings: prevToolOptions ? prevToolOptions.bindings : [],
      },
      prevToolOptions,
      {
        mode: Passive,
      }
    );

    const matchBindings = Array.isArray(options?.removeAllBindings)
      ? options.removeAllBindings
      : this.getDefaultPrimaryBindings();

    // Remove the primary button bindings without modifiers, if they exist
    toolOptions.bindings = toolOptions.bindings.filter(
      (binding) =>
        options?.removeAllBindings !== true &&
        !matchBindings.some((matchBinding) =>
          hasSameBinding(binding, matchBinding)
        )
      //(binding.mouseButton !== defaultMousePrimary || binding.modifierKey)
    );
    // If there are other bindings, set the tool to be active
    let mode = Passive;
    if (toolOptions.bindings.length !== 0) {
      mode = Active;
      toolOptions.mode = mode;
    }

    this.toolOptions[toolName] = toolOptions;
    toolInstance.mode = mode;

    if (typeof toolInstance.onSetToolPassive === 'function') {
      toolInstance.onSetToolPassive();
    }
    this._renderViewports();

    // It would make sense to use `toolInstance.mode` as mode when setting a tool
    // as passive because it can still be active in the end but `Passive` must
    // be used when synchronizing ToolGroups so that other ToolGroups can take the
    // same action (update tool bindings). Should the event have two different modes
    // to handle this special case?
    this._triggerToolModeChangedEvent(toolName, Passive);
  }

  /**
   * Set the tool mode on the toolGroup to be Enabled.
   *
   * - Renders data if the tool has a `renderAnnotation` method..
   *
   * @param toolName - tool name
   */
  public setToolEnabled(toolName: string): void {
    const toolInstance = this._toolInstances[toolName];

    if (toolInstance === undefined) {
      console.warn(
        `Tool ${toolName} not added to toolGroup, can't set tool mode.`
      );

      return;
    }

    const toolOptions = {
      bindings: [],
      mode: Enabled,
    };

    this.toolOptions[toolName] = toolOptions;
    toolInstance.mode = Enabled;

    if (typeof toolInstance.onSetToolEnabled === 'function') {
      toolInstance.onSetToolEnabled();
    }

    this._renderViewports();
    this._triggerToolModeChangedEvent(toolName, Enabled);
  }

  /**
   * Set the tool mode on the toolGroup to be Disabled.
   *
   * - Annotation does not render.
   *
   * @param toolName - tool name
   */
  public setToolDisabled(toolName: string): void {
    const toolInstance = this._toolInstances[toolName];

    if (toolInstance === undefined) {
      console.warn(
        `Tool ${toolName} not added to toolGroup, can't set tool mode.`
      );

      return;
    }

    const toolOptions = {
      bindings: [],
      mode: Disabled,
    };

    this.restoreToolOptions[toolName] = this.toolOptions[toolName];

    this.toolOptions[toolName] = toolOptions;
    toolInstance.mode = Disabled;

    if (typeof toolInstance.onSetToolDisabled === 'function') {
      toolInstance.onSetToolDisabled();
    }
    this._renderViewports();
    this._triggerToolModeChangedEvent(toolName, Disabled);
  }

  /**
   * Get the options for a given tool
   * @param toolName - The name of the tool.
   * @returns the tool options
   */
  public getToolOptions(toolName: string): ToolOptionsType {
    const toolOptionsForTool = this.toolOptions[toolName];

    if (toolOptionsForTool === undefined) {
      return;
    }

    return toolOptionsForTool;
  }

  /**
   * Find the name of the tool that is Active and has a primary button binding
   * (Mouse primary click)
   *
   * @returns The name of the tool
   */
  public getActivePrimaryMouseButtonTool(): string {
    return Object.keys(this.toolOptions).find((toolName) => {
      const toolOptions = this.toolOptions[toolName];
      return (
        toolOptions.mode === Active &&
        this._hasMousePrimaryButtonBinding(toolOptions)
      );
    });
  }

  public setViewportsCursorByToolName(
    toolName: string,
    strategyName?: string
  ): void {
    const cursor = this._getCursor(toolName, strategyName);

    this._setCursorForViewports(cursor);
  }

  private _getCursor(toolName: string, strategyName?: string): MouseCursor {
    let cursorName;
    let cursor;

    if (strategyName) {
      // Try combinations with strategyName first:
      // Try with toolName and toolInstanceName first.
      cursorName = `${toolName}.${strategyName}`;

      cursor = SVGMouseCursor.getDefinedCursor(cursorName, true);

      if (cursor) {
        return cursor;
      }
    }

    // Try with toolName and toolInstanceName first.
    cursorName = `${toolName}`;

    cursor = SVGMouseCursor.getDefinedCursor(cursorName, true);

    if (cursor) {
      return cursor;
    }

    // Try with just toolName.
    cursorName = toolName;

    cursor = SVGMouseCursor.getDefinedCursor(cursorName, true);

    if (cursor) {
      return cursor;
    }

    return MouseCursor.getDefinedCursor('default');
  }

  _setCursorForViewports(cursor: MouseCursor): void {
    const runtimeSettings = Settings.getRuntimeSettings();
    if (!runtimeSettings.get('useCursors')) {
      return;
    }

    this.viewportsInfo.forEach(({ renderingEngineId, viewportId }) => {
      const enabledElement = getEnabledElementByIds(
        viewportId,
        renderingEngineId
      );

      if (!enabledElement) {
        return;
      }

      const { viewport } = enabledElement;
      initElementCursor(viewport.element, cursor);
    });
  }

  /**
   * Set a configuration of a tool by the given toolName.
   * Use overwrite as true in case you want to overwrite any existing configuration (be careful, depending on config change it might break the annotation flow).
   */
  public setToolConfiguration(
    toolName: string,
    configuration: ToolConfiguration,
    overwrite?: boolean
  ): boolean {
    const toolInstance = this._toolInstances[toolName];
    if (toolInstance === undefined) {
      console.warn(
        `Tool ${toolName} not present, can't set tool configuration.`
      );
      return false;
    }

    let _configuration;

    if (overwrite) {
      _configuration = configuration;
    } else {
      // We should not deep copy here, it is the job of the application to
      // deep copy the configuration before passing it to the toolGroup, otherwise
      // some strange appending behaviour happens for the arrays
      _configuration = Object.assign(toolInstance.configuration, configuration);
    }

    toolInstance.configuration = _configuration;

    if (typeof toolInstance.onSetToolConfiguration === 'function') {
      toolInstance.onSetToolConfiguration();
    }

    this._renderViewports();

    return true;
  }

  /**
   * Returns the default mouse primary button.
   */
  public getDefaultMousePrimary(): MouseBindings {
    return MouseBindings.Primary;
  }

  /**
   * Gets an array of bindings that is the full primary binding.
   * Currently this is just the primary mouse button, but may be extended in the
   * future to include touch or other binding types.
   */
  public getDefaultPrimaryBindings(): IToolBinding[] {
    return PRIMARY_BINDINGS;
  }

  /**
   * Get the configuration of tool. It returns only the config for the given path (in case exists).
   * ConfigurationPath is the the path of the property to get separated by '.'.
   *
   * @example
   * getToolConfiguration('LengthTool', 'firstLevel.secondLevel')
   * // get from LengthTool instance the configuration value as being LengthToolInstance[configuration][firstLevel][secondLevel]
   */
  getToolConfiguration(toolName: string, configurationPath?: string): unknown {
    if (this._toolInstances[toolName] === undefined) {
      console.warn(
        `Tool ${toolName} not present, can't set tool configuration.`
      );
      return;
    }

    const _configuration =
      get(this._toolInstances[toolName].configuration, configurationPath) ||
      this._toolInstances[toolName].configuration;

    return utilities.deepClone(_configuration);
  }

  /**
   * Gets the name of the previously active tool.
   * @returns The name of the previously active tool.
   */
  public getPrevActivePrimaryToolName(): string {
    return this.prevActivePrimaryToolName;
  }

  /**
   * Set Primary tool active
   * Get the current active primary tool name and disable that
   * And set the new tool active
   */
  public setActivePrimaryTool(toolName: string): void {
    const activeToolName = this.getCurrentActivePrimaryToolName();
    this.setToolDisabled(activeToolName);
    this.setToolActive(toolName, {
      bindings: [{ mouseButton: MouseBindings.Primary }],
    });
  }

  public getCurrentActivePrimaryToolName(): string {
    return this.currentActivePrimaryToolName;
  }

  /**
   *
   * @param newToolGroupId - Id of the new (clone) tool group
   * @param fnToolFilter - Function to filter which tools from this tool group
   * should be added to the new (clone) one. Example: only annotations tools
   * can be filtered and added to the new tool group.
   * @returns A new tool group that is a clone of this one
   */
  public clone(
    newToolGroupId,
    fnToolFilter: (toolName: string) => void = null
  ): IToolGroup {
    let toolGroup = getToolGroup(newToolGroupId);

    if (toolGroup) {
      console.debug(`ToolGroup ${newToolGroupId} already exists`);
      return toolGroup;
    }

    toolGroup = new ToolGroup(newToolGroupId);
    state.toolGroups.push(toolGroup);

    fnToolFilter = fnToolFilter ?? (() => true);

    Object.keys(this._toolInstances)
      .filter(fnToolFilter)
      .forEach((toolName) => {
        const sourceToolInstance = this._toolInstances[toolName];
        const sourceToolOptions = this.toolOptions[toolName];
        const sourceToolMode = sourceToolInstance.mode;

        toolGroup.addTool(toolName);

        (toolGroup as unknown as ToolGroup).setToolMode(
          toolName,
          sourceToolMode,
          {
            bindings: sourceToolOptions.bindings ?? [],
          }
        );
      });

    return toolGroup;
  }

  /**
   * Check if the tool binding is set to be primary mouse button.
   * @param toolOptions - The options for the tool mode.
   * @returns A boolean value.
   */
  private _hasMousePrimaryButtonBinding(toolOptions) {
    const primaryBindings = this.getDefaultPrimaryBindings();
    return toolOptions?.bindings?.some((binding) =>
      primaryBindings.some((primary) => hasSameBinding(binding, primary))
    );
  }

  /**
   * It re-renders the viewports in the toolGroup
   */
  private _renderViewports(): void {
    this.viewportsInfo.forEach(({ renderingEngineId, viewportId }) => {
      getRenderingEngine(renderingEngineId).renderViewport(viewportId);
    });
  }

  /**
   * Trigger ToolModeChangedEvent when changing the tool mode
   * @param toolName - Tool name
   * @param mode - Tool mode
   * @param toolBindingsOptions - Binding options used when a tool is activated
   */
  private _triggerToolModeChangedEvent(
    toolName: string,
    mode: ToolModes,
    toolBindingsOptions?: SetToolBindingsType
  ): void {
    const eventDetail: ToolModeChangedEventDetail = {
      toolGroupId: this.id,
      toolName,
      mode,
      toolBindingsOptions,
    };

    triggerEvent(eventTarget, Events.TOOL_MODE_CHANGED, eventDetail);
  }

  private _findRenderingEngine(
    viewportId: string,
    renderingEngineId?: string
  ): string {
    const renderingEngines = getRenderingEngines();

    if (renderingEngines?.length === 0) {
      throw new Error('No rendering engines found.');
    }

    if (renderingEngineId) {
      return renderingEngineId;
    }

    const matchingEngines = renderingEngines.filter((engine) =>
      engine.getViewport(viewportId)
    );

    if (matchingEngines.length === 0) {
      if (renderingEngines.length === 1) {
        return renderingEngines[0].id;
      }
      throw new Error(
        'No rendering engines found that contain the viewport with the same viewportId, you must specify a renderingEngineId.'
      );
    }

    if (matchingEngines.length > 1) {
      throw new Error(
        'Multiple rendering engines found that contain the viewport with the same viewportId, you must specify a renderingEngineId.'
      );
    }

    return matchingEngines[0].id;
  }
}

/**
 * Figure out if the two bindings are the same
 */
function hasSameBinding(
  binding1: IToolBinding,
  binding2: IToolBinding
): boolean {
  if (binding1.mouseButton !== binding2.mouseButton) {
    return false;
  }
  if (binding1.numTouchPoints !== binding2.numTouchPoints) {
    return false;
  }

  return binding1.modifierKey === binding2.modifierKey;
}
