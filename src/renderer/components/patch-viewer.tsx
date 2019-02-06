import * as Path from 'path';
import * as fs from 'fs';
import * as React from 'react';
import * as Git from 'nodegit';
import { RepoState, PatchType } from '../repo-state'

// Load Monaco

const loadMonaco = require('monaco-loader')
let monaco: any;
loadMonaco().then((m: any) => {
  monaco = m;
});

// Util

async function getBlob(repo: Git.Repository, file: Git.DiffFile) {
  try {
    return (await repo.getBlob(file.id())).toString();
  } catch (e) {
    return new Promise<string>((resolve, reject) => {
      fs.readFile(Path.join(Path.dirname(repo.path()), file.path()), (error, data) => {
        if (!error) {
          resolve(data.toString());
        } else {
          reject(error);
        }
      });
    })
  }
}

function comparePatches(lhs: Git.ConvenientPatch, rhs: Git.ConvenientPatch) {
  return lhs.oldFile().id().equal(rhs.oldFile().id()) &&
    lhs.newFile().id().equal(rhs.newFile().id()) &&
    lhs.status() === rhs.status() &&
    lhs.size() === rhs.size();
}

// PatchViewer

const LINE_HEIGHT = 19; // To improve

enum ViewMode {
  Hunk,
  Inline,
  Split
}

enum Editor {
  Original,
  Modified,
  Count
}

export interface PatchViewerProps { 
  repo: RepoState;
  patch: Git.ConvenientPatch;
  type: PatchType;
  onEscapePressed: () => void;
}

export class PatchViewer extends React.PureComponent<PatchViewerProps, {}> {
  editor: any;
  viewMode: ViewMode;
  viewZoneIds: number[][];
  overlayWidgets: any[][];
  actionDisposables: any[];
  lineNumbers: ((i: number) => number)[];
  oldBlob: string;
  newBlob: string;
  hunks: Git.ConvenientHunk[];
  lines: Git.DiffLine[];
  loadingPromise: Promise<void>;
  marginButtonsDirty: boolean;

  constructor(props: PatchViewerProps) {
    super(props);
    this.editor = null;
    this.viewMode = ViewMode.Hunk;
    this.viewZoneIds = [[], []];
    this.overlayWidgets = [[], []];
    this.actionDisposables = [];
    this.marginButtonsDirty = false;
    this.setUpEditor = this.setUpEditor.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleSelectedLinesDiscard = this.handleSelectedLinesDiscard.bind(this);
    this.handleSelectedLinesStage = this.handleSelectedLinesStage.bind(this);
    this.handleSelectedLinesUnstage = this.handleSelectedLinesUnstage.bind(this);
  }

  componentDidMount() {
    window.addEventListener('keyup', this.handleKeyUp);
  }

  componentWillUnmount() {
    window.removeEventListener('keyup', this.handleKeyUp);
  }

  componentDidUpdate(prevProps: PatchViewerProps) {
    if (this.props.type !== prevProps.type || !comparePatches(this.props.patch, prevProps.patch)) {
      this.loadAndUpdate();
    }
  }

  handleKeyUp(event: KeyboardEvent) {
    if (event.keyCode === 27) {
      this.props.onEscapePressed();
    }
  }

  handleViewModeChange(viewMode: ViewMode) {
    if (viewMode !== this.viewMode) {
      this.viewMode = viewMode;
      if (this.editor) {
        this.updateEditor();
      }
    }
  }

  async handleSelectedLinesDiscard(editor: any) {
    this.props.repo.discardLines(this.props.patch, await this.getSelectedLines(editor));
  }

  async handleSelectedLinesStage(editor: any) {
    this.props.repo.stageLines(this.props.patch, await this.getSelectedLines(editor));
  }

  async handleSelectedLinesUnstage(editor: any) {
    this.props.repo.unstageLines(this.props.patch, await this.getSelectedLines(editor));
  }

  handleMarginButtonClick(i: number, editor: Editor) {
    let line: Git.DiffLine | undefined;
    if (editor === Editor.Original) {
      line = this.lines.find((line) => line.oldLineno() === this.lineNumbers[editor](i));
    } else if (editor === Editor.Modified) {
      line = this.lines.find((line) => line.newLineno() === this.lineNumbers[editor](i));
    }
    if (line) {
      if (this.props.type === PatchType.Unstaged) {
        this.props.repo.stageLines(this.props.patch, [line]);
      } else if (this.props.type === PatchType.Staged) {
        this.props.repo.unstageLines(this.props.patch, [line]);
      }
    }
  }

  async loadAndUpdate() {
    await this.loadData();
    if (this.editor) {
      this.updateEditor();
    }
  }

  async loadData() {
    const repo = this.props.repo.repo;
    const patch = this.props.patch;
    // Load old blob
    let oldPromise: Promise<string>;
    if (this.props.patch.isAdded()) {
      oldPromise = Promise.resolve('');
    } else {
      oldPromise = getBlob(repo, patch.oldFile());
    }
    // Load new blob
    let newPromise: Promise<string>;
    if (this.props.patch.isDeleted()) {
      newPromise = Promise.resolve('');
    } else {
      newPromise = getBlob(repo, patch.newFile());
    }
    // Load hunks
    const [oldBlob, newBlob, hunks] = await Promise.all([oldPromise, newPromise, this.props.patch.hunks()]);
    this.oldBlob = oldBlob;
    this.newBlob = newBlob;
    this.hunks = hunks;
    // Load lines
    this.lines = (await Promise.all(this.hunks.map((hunk) => hunk.lines())))
      .reduce((acc, value) => acc.concat(value), []);
  }

  setUpEditor(element: HTMLDivElement) {
    // Get a DOM ref on the div that will contain monaco
    if (element) {
      const options = {
        //theme: 'vs-dark',
        automaticLayout: true,
        renderSideBySide: false,
        readOnly: true
      }
      this.editor = monaco.editor.createDiffEditor(element, options)
      this.editor.onDidUpdateDiff(() => this.updateMarginButtons());
      this.loadAndUpdate();
    }
  }

  updateEditor() {
    // Update editor options
    this.editor.updateOptions({
      renderSideBySide: this.viewMode === ViewMode.Split
    });
    // Reset editor
    this.resetEditor();
    // Update models
    if (this.viewMode === ViewMode.Hunk) {
      this.setHunkModels(); 
    } else {
      this.setBlobModels();
    }
  }

  resetEditor() {
    // Reset view zones
    const editors = [this.editor.getOriginalEditor(), this.editor.getModifiedEditor()];
    for (let i = 0; i < Editor.Count; ++i) {
      const editor = editors[i];
      editor.changeViewZones((changeAccessor: any) => {
        for (let viewZoneId of this.viewZoneIds[i]) {
          changeAccessor.removeZone(viewZoneId);
        }
      });
      this.viewZoneIds[i] = [];
      // Reset overlay widgets
      for (let overlayWidget of this.overlayWidgets[i]) {
        editor.removeOverlayWidget(overlayWidget);
      }
      this.overlayWidgets[i] = [];
    }
    // Reset context menu
    for (let actionDisposable of this.actionDisposables) {
      actionDisposable.dispose();
    }
    this.actionDisposables = [];
    // Reset line numbers
    this.setLineNumbers((i: number) => i, (i: number) => i); 
    // Reset margin buttons
    this.marginButtonsDirty = true;
  }

  setHunkModels() {
    function generateLineNumbers(starts: number[], offsets: number[]) {
      return (i: number) => {
        let j = 0;
        while (i >= starts[j + 1]) {
          ++j;
        }
        return i + offsets[j];
      }
    }

    // Extract hunks from files
    const oldLines = this.oldBlob.split('\n');
    const oldHunks: string[] = [];
    const oldOffsets: number[] = [];
    const oldStarts = [1];
    const newLines = this.newBlob.split('\n');
    const newHunks: string[] = [];
    const newOffsets: number[] = [];
    const newStarts = [1];
    for (let hunk of this.hunks) {
      const oldStart = hunk.oldStart();
      const oldLength = hunk.oldLines();
      oldHunks.push(oldLines.slice(oldStart - 1, oldStart - 1 + oldLength).join('\n'));
      oldOffsets.push(oldStart - oldStarts[oldStarts.length - 1]);
      oldStarts.push(oldStarts[oldStarts.length - 1] + oldLength);
      const newStart = hunk.newStart();
      const newLength = hunk.newLines();
      newHunks.push(newLines.slice(newStart - 1, newStart - 1 + newLength).join('\n'));
      newOffsets.push(newStart - newStarts[newStarts.length - 1]);
      newStarts.push(newStarts[newStarts.length - 1] + newLength);
    }
    // Set models
    this.setModels(oldHunks.join('\n'), newHunks.join('\n'));
    // Set line numbers
    this.setLineNumbers(generateLineNumbers(oldStarts, oldOffsets), 
      generateLineNumbers(newStarts, newOffsets));
    const editor = this.editor.getModifiedEditor();
    // Add hunk widgets
    for (let i = 0; i < this.hunks.length; ++i) {
      this.createHunkWidget(editor, this.hunks[i], newStarts[i] - 1, 
        `hunk.${this.overlayWidgets[Editor.Modified].length}`);
    }
    // Customize context menu
    this.setContextMenu(editor);
  }

  createHunkWidget(editor: any, hunk: Git.ConvenientHunk, start: number, hunkId: string) {
    const repo = this.props.repo;
    const patch = this.props.patch;

    const overlayNode = document.createElement('div');
    overlayNode.classList.add('overlay-zone');

    const contentNode = document.createElement('div');
    const textNode = document.createElement('p');
    textNode.textContent = `@@ -${hunk.oldStart()},${hunk.oldLines()} +${hunk.newStart()},${hunk.newLines()}`;
    contentNode.appendChild(textNode);
    if (this.props.type === PatchType.Unstaged) {
      const buttonsNode = document.createElement('div');
      // Discard button
      const discardButton = document.createElement('button');
      discardButton.textContent = 'Discard';
      discardButton.addEventListener('click', repo.discardHunk.bind(repo, patch, hunk));
      buttonsNode.appendChild(discardButton);
      // Stage button
      const stageButton = document.createElement('button');
      stageButton.textContent = 'Stage';
      stageButton.addEventListener('click', repo.stageHunk.bind(repo, patch, hunk));
      buttonsNode.appendChild(stageButton);
      contentNode.appendChild(buttonsNode);
    } else if (this.props.type === PatchType.Staged) {
      const buttonsNode = document.createElement('div');
      // Unstage button
      const unstageButton = document.createElement('button');
      unstageButton.textContent = 'Unstage';
      unstageButton.addEventListener('click', repo.unstageHunk.bind(repo, patch, hunk));
      buttonsNode.appendChild(unstageButton);
      contentNode.appendChild(buttonsNode);
    }
    overlayNode.appendChild(contentNode);

    const overlayWidget = {
      getId: () => hunkId,
      getDomNode: () => overlayNode,
      getPosition: () => null
    };
    editor.addOverlayWidget(overlayWidget);
    this.overlayWidgets[Editor.Modified].push(overlayWidget);

    // Used only to compute the position.
    const zoneNode = document.createElement('div');
    editor.changeViewZones((changeAccessor: any) => {
      this.viewZoneIds[Editor.Modified].push(changeAccessor.addZone({
        afterLineNumber: start,
        heightInLines: 2,
        domNode: zoneNode,
        onDomNodeTop: (top: number) => {
          overlayNode.style.top = top + "px";
        },
        onComputedHeight: (height: number) => {
          overlayNode.style.height = height + "px";
        }
      }));
    });
  }

  setContextMenu(editor: any) {
    if (this.props.type === PatchType.Unstaged) {
      this.actionDisposables.push(
        editor.addAction({
          id: 'discard-selected-lines',
          label: 'Discard selected lines',
          contextMenuGroupId: '1_modification',
          run: this.handleSelectedLinesDiscard
        }),
        editor.addAction({
          id: 'stage-selected-lines',
          label: 'Stage selected lines',
          contextMenuGroupId: '1_modification',
          run: this.handleSelectedLinesStage
        })
      );
    }
    else if (this.props.type === PatchType.Staged) {
      this.actionDisposables.push(editor.addAction({
        id: 'unstage-selected-lines',
        label: 'Unstage selected lines',
        contextMenuGroupId: '1_modification',
        run: this.handleSelectedLinesUnstage
      }));
    }
  } 

  updateMarginButtons() {
    if (this.marginButtonsDirty && this.props.type !== PatchType.Committed && this.viewMode === ViewMode.Hunk) {
      this.createMarginButtons()
      this.marginButtonsDirty = false;
    }
  }
  
  createMarginButtons() {
    const className = this.props.type === PatchType.Unstaged ? 'stage-line-button' : 'unstage-line-button';
    const editors = [this.editor.getOriginalEditor(), this.editor.getModifiedEditor()];

    const createMarginButton = (iEditor: Editor, i: number, prefix: string) => {
      // Create an overlay widget
      const overlayNode = document.createElement('div');
      overlayNode.addEventListener('mousedown', this.handleMarginButtonClick.bind(this, i, iEditor));
      overlayNode.classList.add(className);
      const overlayWidget = {
        getId: () => `${prefix}-${i}`,
        getDomNode: () => overlayNode,
        getPosition: () => null
      };
      editors[Editor.Modified].addOverlayWidget(overlayWidget);
      this.overlayWidgets[Editor.Modified].push(overlayWidget);
      // Create a view zone to compute the position
      const zoneNode = document.createElement('div');
      editors[iEditor].changeViewZones((changeAccessor: any) => {
        this.viewZoneIds[iEditor].push(changeAccessor.addZone({
          afterLineNumber: i,
          heightInLines: 0,
          domNode: zoneNode,
          onDomNodeTop: (top: number) => {
            overlayNode.style.top = top - LINE_HEIGHT + "px";
          }
        }));
      });
    }

    for (let line of this.editor.getLineChanges()) {
      for (let i = line.originalStartLineNumber; i <= line.originalEndLineNumber; ++i) {
        createMarginButton(Editor.Original, i, 'old');
      }
      for (let i = line.modifiedStartLineNumber; i <= line.modifiedEndLineNumber; ++i) {
        createMarginButton(Editor.Modified, i, 'new');
      }
    }
  }

  setBlobModels() {
    this.setModels(this.oldBlob, this.newBlob);
  }

  setModels(oldString: string, newString: string) {
    function updateOrCreateModel(prefix: string, path: string, value: string) {
      const uri = monaco.Uri.parse(`file://${prefix}/${path}`);
      let model = monaco.editor.getModel(uri);
      if (model) {
        model.setValue(value);
      } else {
        model = monaco.editor.createModel(value, undefined, uri);
      }
      return model;
    }
    
    const patch = this.props.patch;
    const originalModel = updateOrCreateModel('a', patch.oldFile().path(), oldString);
    const modifiedModel = updateOrCreateModel('b', patch.newFile().path(), newString);
    this.editor.setModel({
      original: originalModel, 
      modified: modifiedModel
    });
  }

  setLineNumbers(oldLineNumbers: (i: number) => number, newLineNumbers: (i: number) => number) {
    this.editor.getOriginalEditor().updateOptions({
      lineNumbers: oldLineNumbers
    });
    this.editor.getModifiedEditor().updateOptions({
      lineNumbers: newLineNumbers
    });
    this.lineNumbers = [oldLineNumbers, newLineNumbers];
  }

  async getSelectedLines(editor: any) {
    const selection = editor.getSelection();
    const start = this.lines.findIndex((line) => line.newLineno() === this.lineNumbers[Editor.Modified](selection.startLineNumber));
    const end = this.lines.findIndex((line) => line.newLineno() === this.lineNumbers[Editor.Modified](selection.endLineNumber));
    const selectedLines = this.lines.slice(start, end + 1);
    console.log(selection.startLineNumber, selection.endLineNumber);
    console.log(selectedLines.map((line) => line.newLineno()));
    return selectedLines;
  }

  render() {
    return (
      <div className='patch-viewer'>
        <div className='patch-header'>
          <h2>{this.props.patch.newFile().path()}</h2>
        </div>
        <div className="view-mode-selector">
          <input type="radio" id="hunk-mode" name="view-mode-selector" 
            defaultChecked={this.viewMode === ViewMode.Hunk}
            onInput={this.handleViewModeChange.bind(this, ViewMode.Hunk)} />
          <label htmlFor="hunk-mode">Hunk</label >
          <input type="radio" id="inline-mode" name="view-mode-selector" 
            defaultChecked={this.viewMode === ViewMode.Inline}
            onInput={this.handleViewModeChange.bind(this, ViewMode.Inline)} />
          <label htmlFor="inline-mode">Inline</label>
          <input type="radio" id="split-mode" name="view-mode-selector"
            defaultChecked={this.viewMode === ViewMode.Split}
            onInput={this.handleViewModeChange.bind(this, ViewMode.Split)} />
          <label htmlFor="split-mode">Split</label>
        </div>
        <div className='patch-editor' ref={this.setUpEditor} />
      </div>
    );
  }
}