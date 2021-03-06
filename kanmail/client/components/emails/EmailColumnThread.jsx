import _ from 'lodash';
import React from 'react';
import PropTypes from 'prop-types';
import { DragSource } from 'react-dnd';

import { ALIAS_FOLDERS } from 'constants.js';

import keyboard from 'keyboard.js';

import requestStore from 'stores/request.js';
import threadStore from 'stores/thread.js';
import { getEmailStore } from 'stores/emailStoreProxy.js';

import { formatAddress, formatDate } from 'util/string.js';


/*
    Return a list of UIDs for a given folder in this thread.
*/
function getThreadColumnMessageIds(thread, columnId) {
    return _.filter(_.map(thread, message => (
        message.folderUids[columnId]
    )));
}

/*
    Return a map of folder -> UIDs for all messages in this thread.
*/
function getThreadFolderMessageIds(thread) {
    return _.reduce(
        thread,
        (memo, message) => {
            _.each(message.folderUids, (uid, folderName) => {
                if (!memo[folderName]) {
                    memo[folderName] = [];
                }

                memo[folderName].push(uid);
            });

            return memo;
        },
        {},
    );
}


const emailSource = {
    beginDrag(props) {
        // Get account name from the first message in the thread
        const { account_name } = props.thread[0];

        // Get list of message UIDs *for this folder*
        const messageUids = getThreadColumnMessageIds(
            props.thread,
            props.columnId,
        );

        return {
            messageUids: messageUids,
            oldColumn: props.columnId,
            accountName: account_name,
        };
    }
};


function collect(connect, monitor) {
    return {
        connectDragSource: connect.dragSource(),
        isDragging: monitor.isDragging(),
    }
}


@DragSource('email', emailSource, collect)
export default class EmailColumnThread extends React.Component {
    static propTypes = {
        thread: PropTypes.array.isRequired,
        connectDragSource: PropTypes.func.isRequired,
        columnId: PropTypes.string.isRequired,
        isLastThread: PropTypes.bool.isRequired,

        // Surrounding columns
        getColumnContainer: PropTypes.func.isRequired,
        getPreviousColumn: PropTypes.func.isRequired,
        getNextColumn: PropTypes.func.isRequired,

        // Surrounding threads
        getPreviousThread: PropTypes.func.isRequired,
        getNextThread: PropTypes.func.isRequired,
    }

    constructor(props) {
        super(props);

        const { starred, unread, archived } = this.props.thread;

        this.mouseMoveEvents = 0;

        this.state = {
            starred: starred,
            unread: unread,
            archived: archived,
            locked: false,
            open: false,
            hover: false,
            error: false,
        }
    }

    // See below as to why we have to use this unsafe(ish) method
    UNSAFE_componentWillReceiveProps(nextProps) {
        // Ensure that we match any thread props - these are copied to state so that
        // we can star/read/archive a thread without actually re-rendering the entire
        // column, just this component.
        const { starred, unread, archived } = nextProps.thread;

        this.setState({
            starred: starred,
            unread: unread,
            archived: archived,
        });
    }

    // static getDerivedStateFromProps(props, state) {
    //     // NOTE: this method is *useless* because it triggers every render, not just
    //     // when receving props from above. React is annoying.
    //
    //     // Ensure that we match any thread props - these are copied to state so that
    //     // we can star/read/archive a thread without actually re-rendering the entire
    //     // column, just this component.
    //     const { starred, unread, archived } = props.thread;
    //     if (
    //         state.starred !== starred
    //         || state.unread !== unread
    //         || state.archived !== archived
    //     ) {
    //         return {
    //             starred,
    //             unread,
    //             archived,
    //         }
    //     }
    // }

    componentDidUpdate(prevProps) {
        // If we're open and the thread changed, reopen
        if (
            this.state.open
            && prevProps.thread.length !== this.props.thread.length
        ) {
            // Mark the emails as read in the global email store
            if (this.state.unread) {
                getEmailStore().setEmailsRead(_.map(this.props.thread, message => (
                    `${message.account_name}-${message.message_id}`
                )));
            }
            this.setState({
                unread: false,
            });

            threadStore.loadThread(this.props.thread);
        }
    }

    componentWillUnmount() {
        if (this.state.hover) {
            keyboard.setThreadComponent(null);
        }
    }

    /*
        For every message in this thread, *any folder*, generate a move request
        to another folder.
    */
    moveThreadMessages = (targetFolder, previousState, folderFilter=null) => {
        const thread = this.props.thread;

        const allMessageFolderUids = getThreadFolderMessageIds(thread);
        const emailStore = getEmailStore();

        const requests = [];

        _.each(allMessageFolderUids, (uids, folderName) => {
            if (folderFilter !== null && !folderFilter(folderName)) {
                return;
            }

            requests.push(emailStore.moveEmails(
                thread[0].account_name,
                uids,
                folderName,
                targetFolder,
            ));
        });

        return Promise.all(requests).then(() => {
            emailStore.processEmailChanges();
        }).catch((e) => {
            this.setState({
                error: true,
                ...previousState,
            });
            // Re-throw for the requestStore to capture
            throw e;
        });
    }

    setHover = (state=true) => {
        this.setState({
            hover: state,
        });

        if (!state) {
            this.mouseMoveEvents = 0;
        }
    }

    isBusy = () => {
        return this.state.trashing || this.state.archiving;
    }

    getAddressList() {
        return _.uniq(_.reduce(this.props.thread, (memo, message) => {
            memo = _.concat(memo, _.map(message.from, address => (
                formatAddress(address, true)
            )));
            return memo;
        }, []));
    }

    /*
        Hover states/handling
    */
    handleMouseMove = () => {
        // This is an awful hack around mouseMove being triggered when the
        // parent (column) is scrolled.
        this.mouseMoveEvents += 1;
        if (this.mouseMoveEvents <= 1) {
            return;
        }

        if (this.isBusy() || this.state.hover || threadStore.isOpen) {
            return;
        }

        keyboard.setThreadComponent(this);
    }

    handleMouseLeave = () => {
        if (this.isBusy() || threadStore.isOpen) {
            return;
        }

        if (this.state.hover) {
            keyboard.setThreadComponent(null);
        }
    }

    /*
        User action handlers
    */
    handleClick = () => {
        if (this.state.open) {
            threadStore.close();
            return;
        }

        if (!this.state.hover) {
            keyboard.setThreadComponent(this);
        }

        // Mark the emails as read in the global email store
        if (this.state.unread) {
            getEmailStore().setEmailsRead(_.map(this.props.thread, message => (
                `${message.account_name}-${message.message_id}`
            )));
        }

        // Set as open (triggers highlight)
        this.setState({
            open: true,
            unread: false,
        });

        threadStore.open(
            this.props.getColumnContainer(),
            this.props.thread,
            // On close set this thread to an unopened state
            () => {
                this.setState({
                    open: false,
                });
            },
        );
    }

    handleClickStar = (ev) => {
        ev.stopPropagation();

        if (this.state.locked) {
            console.debug('Thread locked, not starring!');
        }

        this.setState({
            starring: true,
            locked: true,
        });

        // Only star messages from this thread in the current column/folder
        const messageUids = getThreadColumnMessageIds(
            this.props.thread,
            this.props.columnId,
        );

        // Star the emails in the store - but don't sync the changes everywhere
        // instead we keep the starred state local to this component, to avoid
        // re-rendering the whole column.
        const emailStore = getEmailStore();
        let action = this.state.starred ? emailStore.unstarEmails : emailStore.starEmails;
        action = action.bind(emailStore);  // fucking JavaScript

        action(
            this.props.thread[0].account_name,
            this.props.columnId,
            messageUids,
        ).then(() => {
            this.setState({
                locked: false,
                starring: false,
                starred: !this.state.starred,
            });
        });
    }

    handleClickArchive = (ev) => {
        ev.stopPropagation();

        if (this.state.open) {
            threadStore.close();
        }

        if (this.state.hover) {
            keyboard.setThreadComponent(null);
        }

        // No double archiving please!
        if (this.state.locked) {
            console.debug('Thread locked, not archiving!');
            return;
        }

        this.setState({
            archiving: true,
            locked: true,
        });

        const previousState = {
            archiving: false,
            locked: false,
        };

        // Move every message in the thread, that exists in non-core folders, or
        // is in the inbox, to the archive. Ie don't move sent/trash/spam -> archive.
        const archiveThread = () => this.moveThreadMessages(
            'archive', previousState,
            folderName => folderName == 'inbox' || !_.includes(ALIAS_FOLDERS, folderName),
        );
        const undoArchive = () => this.setState(previousState);

        requestStore.addUndoable(archiveThread, undoArchive);
    }

    handleClickTrash = (ev) => {
        ev.stopPropagation();

        if (this.props.columnId === 'trash') {
            console.debug('Thread already trashed!');
            return;
        }

        if (this.state.open) {
            threadStore.close();
        }

        if (this.state.hover) {
            keyboard.setThreadComponent(null);
        }

        // No double trashing please!
        if (this.state.locked) {
            console.debug('Thread locked, not trashing!');
            return;
        }

        this.setState({
            trashing: true,
            locked: true,
        });

        const previousState = {
            trashing: false,
            locked: false,
        };

        // Move every messasge in the thread, from any folder, to trash
        const trashThread = () => this.moveThreadMessages(
            'trash', previousState,
        );
        const undoTrash = () => this.setState(previousState);

        requestStore.addUndoable(trashThread, undoTrash);
    }

    handleClickRestore = (ev) => {
        ev.stopPropagation();

        if (this.props.columnId === 'inbox') {
            console.debug('Thread already in inbox!');
            return;
        }

        if (this.state.open) {
            threadStore.close();
        }

        if (this.state.hover) {
            keyboard.setThreadComponent(null);
        }

        // No double trashing please!
        if (this.state.restoring) {
            console.debug('Thread locked, not restoring!');
            return;
        }

        this.setState({
            restoring: true,
            locked: true,
        });

        const previousState = {
            restoring: false,
            locked: false,
        };

        // Move every message from the thread in this folder/column to the inbox
        const restoreThread = () => this.moveThreadMessages(
            'inbox', previousState,
            folderName => folderName == this.props.columnId,
        );
        const undoRestore = () => this.setState(previousState);

        requestStore.addUndoable(restoreThread, undoRestore);
    }

    /*
        Render
    */
    renderStarButton() {
        if (_.includes(['trash', 'spam'], this.props.columnId)) {
            return;
        }

        const classNames = ['fa'];

        if (this.state.starring) {
            classNames.push('fa-cog');
            classNames.push('fa-spin');
        } else {
            if (this.state.starred) {
                classNames.push('fa-star');
            } else {
                classNames.push('fa-star-o');
            }
        }

        return (
            <a
                onClick={this.handleClickStar}
                className={`star ${this.state.starred ? 'active' : ''}`}
            >
                <i className={classNames.join(' ')}></i>
            </a>
        );
    }

    renderArchiveButton() {
        if (_.includes(['trash', 'spam', 'archive'], this.props.columnId)) {
            return;
        }

        const classNames = ['fa'];

        if (this.state.archiving) {
            classNames.push('fa-cog');
            classNames.push('fa-spin');
        } else {
            classNames.push('fa-archive');
        }

        return (
            <a
                onClick={this.handleClickArchive}
                className='archive'
            >
                <i className={classNames.join(' ')}></i>
            </a>
        );
    }

    renderRestoreButton() {
        if (!_.includes(['trash', 'spam'], this.props.columnId)) {
            return;
        }

        const classNames = ['fa'];

        if (this.state.restoring) {
            classNames.push('fa-cog');
            classNames.push('fa-spin');
        } else {
            classNames.push('fa-inbox');
        }

        return (
            <a
                onClick={this.handleClickRestore}
                className='archive'
            >
                <i className={classNames.join(' ')}></i>
            </a>
        );
    }

    renderTrashButton() {
        if (this.props.columnId === 'trash') {
            return;
        }

        const classNames = ['fa'];

        if (this.state.trashing) {
            classNames.push('fa-cog');
            classNames.push('fa-spin');
        } else {
            classNames.push('fa-trash');
        }

        return (
            <a
                onClick={this.handleClickTrash}
                className='trash'
            >
                <i className={classNames.join(' ')}></i>
            </a>
        );
    }

    renderAttachmentCount() {
        const attachmentCount = _.reduce(this.props.thread, (memo, message) => {
            const count = message.parts.attachments.length || 0;
            memo += count;
            return memo;
        }, 0);

        if (attachmentCount === 0) {
            return;
        }

        return (
            <span>
                &nbsp;/&nbsp;
                <i className="fa fa-paperclip"></i> {attachmentCount}
            </span>
        );
    }

    render() {
        const { connectDragSource, thread } = this.props;
        const latestEmail = thread[0];
        const addresses = this.getAddressList();

        const classNames = ['email'];

        _.each(['hover', 'unread', 'open', 'error'], key => {
            if (this.state[key]) {
                classNames.push(key);
            }
        });

        if (this.state.archiving) {
            classNames.push('archiving');
        }

        if (this.state.trashing) {
            classNames.push('trashing');
        }

        if (this.state.archived) {
            classNames.push('archived');
        }

        return connectDragSource(
            <div
                className={classNames.join(' ')}
                onClick={this.handleClick}
                onMouseMove={this.handleMouseMove}
                onMouseLeave={this.handleMouseLeave}
                ref={(ref) => this.element = ref}
            >
                <h5>
                    <span className="date">
                        {formatDate(latestEmail.date)}
                    </span>
                    {addresses.join(', ')}
                </h5>
                <h4>
                    {latestEmail.subject}
                </h4>
                <p>{latestEmail.excerpt}</p>
                <div className="meta">
                    <i className="fa fa-google"></i> {latestEmail.account_name}
                    &nbsp;/&nbsp;
                    <i className="fa fa-envelope-o"></i> {thread.length}
                    &nbsp;/&nbsp;
                    <i className="fa fa-user-o"></i> {addresses.length}
                    {this.renderAttachmentCount()}

                    <span className="buttons">
                        {this.renderStarButton()}
                        {this.renderArchiveButton()}
                        {this.renderRestoreButton()}
                        {this.renderTrashButton()}
                    </span>
                </div>
            </div>
        );
    }
}
