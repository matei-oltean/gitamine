import * as Path from 'path';
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import * as React from 'react';
import * as Git from 'nodegit';
import { GraphViewer } from './graph-viewer';
import { CommitViewer } from './commit-viewer';
import { IndexViewer } from './index-viewer';
import { PatchViewer } from './patch-viewer';
import { TextPatchViewerOptions } from './text-patch-viewer';
import { Splitter } from './splitter';
import { Toolbar } from './toolbar';
import { LoadingScreen, LoadingState } from './loading-screen';
import { InputDialogHandler } from './input-dialog';
import { RepoWrapper, PatchType, RepoState } from '../helpers/repo-wrapper';
import { CancellablePromise, makeCancellable } from '../helpers/make-cancellable';

export interface RepoDashboardProps { 
  repo: RepoWrapper;
  editorTheme: string;
  patchViewerOptions: TextPatchViewerOptions;
  onRepoClose: () => void;
  onCreateBranch: (commit: Git.Commit) => void;
  onOpenInputDialog: InputDialogHandler;
}

export interface RepoDashboardState { 
  repoState: RepoState;
  loadingState: LoadingState;
  selectedCommit: Git.Commit | null;
  selectedPatch: Git.ConvenientPatch | null;
  patchType: PatchType;
}

export class RepoDashboard extends React.PureComponent<RepoDashboardProps, RepoDashboardState> {
  // Loading
  loadingPromise: CancellablePromise<void>;
  graphShrunk: boolean;
  // References
  graphViewer: React.RefObject<GraphViewer>;
  rightViewer: React.RefObject<CommitViewer | IndexViewer>;
  // Watches
  repositoryWatcher: fs.FSWatcher;
  dirtyWorkingDirectory: boolean;
  workingDirectoryWatcher: chokidar.FSWatcher;
  workingDirectoryTimer: NodeJS.Timer;
  referencesWatcher: chokidar.FSWatcher;

  constructor(props: RepoDashboardProps) {
    super(props);
    this.graphShrunk = false;
    this.graphViewer = React.createRef();
    this.rightViewer = React.createRef();
    this.dirtyWorkingDirectory = false;
    this.handleCommitSelect = this.handleCommitSelect.bind(this);
    this.handleIndexSelect = this.handleIndexSelect.bind(this);
    this.handlePatchSelect = this.handlePatchSelect.bind(this);
    this.exitPatchViewer = this.exitPatchViewer.bind(this);
    this.handleRightPanelResize = this.handleRightPanelResize.bind(this);
    this.state = {
      repoState: this.props.repo.getState(),
      loadingState: LoadingState.NotLoading,
      selectedCommit: null,
      selectedPatch: null,
      patchType: PatchType.Committed
    };
  }

  async componentDidMount() {
    this.loadingPromise = makeCancellable(this.props.repo.init());
    try {
      await this.loadingPromise.promise;
      this.setState({
        loadingState: LoadingState.Loaded
      });
      this.setWatchers();
    } catch (e) {
    }
  }

  componentDidUpdate() {
    if (!this.graphShrunk && this.graphViewer.current) {
      this.graphShrunk = true;
      this.graphViewer.current.shrinkCanvas();
    }
  }

  componentWillUnmount() {
    if (this.loadingPromise) {
      this.loadingPromise.cancel();
    }
    this.removeWatchers();
  }

  handleCommitSelect(commit: Git.Commit) {
    return new Promise((resolve) => {
      this.setState({
        selectedCommit: commit
      }, () => resolve());
    });
  }

  handleIndexSelect() {
    return new Promise((resolve) => {
      this.setState({
        selectedCommit: null
      }, () => resolve());
    });
  }

  handlePatchSelect(patch: Git.ConvenientPatch | null, type: PatchType) {
    this.setState({
      selectedPatch: patch,
      patchType: type
    });
  }

  exitPatchViewer() {
    this.setState({
      selectedPatch: null
    });
  }

  handleRightPanelResize(offset: number) {
    if (this.rightViewer.current) {
      this.rightViewer.current.resize(offset);
    }
  }
  
  setWatchers() {
    const path = this.props.repo.path;
    // Watch index and head 
    // fs.watch seems sufficient for that, I should try with chokidar
    this.repositoryWatcher = fs.watch(path, async (error: string, filename: string) => {
      if (filename === 'index') {
        this.refreshIndex();
      } else if (filename === 'HEAD') {
        await this.refreshHead();
        this.refreshIndex();
      }
    });

    // Watch working directory
    const wdPath = this.props.repo.repo.workdir();
    this.workingDirectoryWatcher = chokidar.watch(wdPath, {
      ignoreInitial: true,
      ignored: [/(.*\.git(\/.*|$))/, (path: string) => this.props.repo.isIgnored(Path.relative(wdPath, path))],
      followSymlinks: false,
    });
    this.workingDirectoryWatcher.on('all', async (event: string, path: string) => {
      if (path.endsWith('.gitignore')) {
        this.props.repo.updateIgnore();
      }
      this.dirtyWorkingDirectory = true;
    });
    // To prevent from updating too often
    this.workingDirectoryTimer = setInterval(async () => {
      if (this.dirtyWorkingDirectory) {
        this.refreshIndex();
        this.dirtyWorkingDirectory = false;
      }
    }, 200);

    // Watch references
    this.referencesWatcher = chokidar.watch(Path.join(path, 'refs'), {
      ignoreInitial: true,
      ignored: /.*\.lock$/,
      followSymlinks: false
    });
    this.referencesWatcher.on('all', async (event: string, path: string) => {
      await this.refreshReferences();
      this.refreshIndex();
    });
  }

  removeWatchers() {
    if (this.repositoryWatcher) {
      this.repositoryWatcher.close();
    }
    if (this.workingDirectoryWatcher) {
      this.workingDirectoryWatcher.close();
    }
    if (this.workingDirectoryTimer) {
      clearInterval(this.workingDirectoryTimer);
    }
    if (this.referencesWatcher) {
      this.referencesWatcher.close();
    }
  }

  async refreshIndex() {
    if (!this.state.selectedCommit && this.rightViewer.current) {
      this.setState({
        repoState: this.props.repo.getState()
      });
      const indexViewer = this.rightViewer.current as IndexViewer;
      await indexViewer.refresh();
      if (this.state.selectedPatch && this.state.patchType !== PatchType.Committed) {
        indexViewer.refreshSelectedPatch(this.state.patchType === PatchType.Unstaged);
      }
    }
  }

  async refreshHead() {
    await this.props.repo.updateHead();
    await this.props.repo.updateGraph();
    if (this.graphViewer.current) {
      this.graphViewer.current.updateGraph();
    }
  }

  async refreshReferences() {
    // TODO: update only references that changed
    await this.props.repo.requestUpdateCommits();
    await this.props.repo.updateHead();
    await this.props.repo.updateGraph();
    if (this.graphViewer.current) {
      this.graphViewer.current.updateGraph();
    }
    // If the selected commit is removed, switch to index
    if (this.state.selectedCommit && 
      !this.props.repo.shaToCommit.has(this.state.selectedCommit.sha())) {
        this.handleIndexSelect();
    }
  }

  render() {
    let leftViewer; 
    if (this.state.selectedPatch) {
      leftViewer = <PatchViewer repo={this.props.repo} 
        patch={this.state.selectedPatch!} 
        patchType={this.state.patchType}
        editorTheme={this.props.editorTheme}
        options={this.props.patchViewerOptions}
        onClose={this.exitPatchViewer} /> 
    } else {
      if (this.state.loadingState !== LoadingState.Loaded) {
        leftViewer = <LoadingScreen state={this.state.loadingState} />
      } else {
        leftViewer = <GraphViewer repo={this.props.repo} 
          repoState={this.state.repoState}
          selectedCommit={this.state.selectedCommit} 
          onCommitSelect={this.handleCommitSelect}
          onIndexSelect={this.handleIndexSelect} 
          onCreateBranch={this.props.onCreateBranch}
          onOpenInputDialog={this.props.onOpenInputDialog}
          ref={this.graphViewer} />
      }
    }
    let rightViewer;
    if (this.state.selectedCommit) {
      rightViewer = <CommitViewer repo={this.props.repo}
        commit={this.state.selectedCommit} 
        selectedPatch={this.state.selectedPatch} 
        onCommitSelect={this.handleCommitSelect}
        onPatchSelect={this.handlePatchSelect} 
        ref={this.rightViewer as React.RefObject<CommitViewer>} />
    } else {
      rightViewer = <IndexViewer repo={this.props.repo} 
        repoState={this.state.repoState}
        selectedPatch={this.state.selectedPatch} 
        onPatchSelect={this.handlePatchSelect} 
        ref={this.rightViewer as React.RefObject<IndexViewer>} />
    }
    return (
      <div className='repo-dashboard'>
        <Toolbar repo={this.props.repo} 
          selectedCommit={this.state.selectedCommit} 
          onRepoClose={this.props.onRepoClose} 
          onCreateBranch={this.props.onCreateBranch} />
        <div className='repo-content'>
          {leftViewer}
          <Splitter onDrag={this.handleRightPanelResize} />
          {rightViewer}
        </div>
      </div>
    );
  }
}